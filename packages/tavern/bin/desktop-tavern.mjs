/**
 * Launch the unpackaged Electron desktop shell with the Tavern plugin bundles mounted.
 *
 * Mirrors apps/desktop/scripts/dev.ts for 0.2 (target-aware disposable project, primary
 * runtime preparation, Electron-as-Node release identity) and re-applies the Tavern
 * bundle set to the freshly generated disposable profile before Electron starts.
 *
 * Usage: node_modules/.bin/tsx packages/tavern/bin/desktop-tavern.mjs [--skip-build]
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { DESKTOP_HOST_PROTOCOL_VERSION } from '../../../apps/desktop/src/host-protocol.ts'
import { resolveDesktopBuildTarget } from '../../../apps/desktop/scripts/desktop-build-paths.mjs'
import { prepareDevelopmentProject } from '../../../apps/desktop/scripts/development-project.ts'
import { preparePrimaryRuntime } from '../../../apps/desktop/scripts/prepare-primary-runtime.ts'
import { developmentRuntimeDirectory } from '../../../apps/desktop/scripts/desktop-build-paths.mjs'

const REPOSITORY_ROOT = resolve(import.meta.dirname, '..', '..', '..')
const APP_ROOT = join(REPOSITORY_ROOT, 'apps', 'desktop')
const DEVELOPMENT_ROOT = join(APP_ROOT, '.desktop-build', 'development')
const PROJECT_DIR = join(DEVELOPMENT_ROOT, 'project')
const TAVERN_BUNDLES = ['dsh-tavern-plugin', 'dsh-tavern-remote', 'dsh-better-sidebar']
const BUILTIN_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function electronExecutable() {
  for (const anchor of [join(APP_ROOT, 'package.json'), import.meta.url]) {
    try {
      const resolved = createRequire(anchor)('electron')
      if (typeof resolved === 'string') return resolved
    } catch (error) {
      if (error?.code !== 'MODULE_NOT_FOUND') throw error
    }
  }
  throw new Error('desktop tavern: the electron executable is unavailable; run pnpm install')
}

function run(command, args, cwd, environment = process.env) {
  return new Promise((settle, reject) => {
    const child = spawn(command, args, { cwd, env: environment, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) settle()
      else reject(new Error(`desktop tavern: ${args.join(' ')} exited with ${String(code)}`))
    })
  })
}

/** Stop the previously launched shell so its single-instance lock and profile directory are free. */
async function stopRunningShell() {
  // Match on spell-stable distinctive substrings: the Electron shell always
  // carries the development user-data dir, the Host child its app directory.
  const script = [
    `$shells = @(Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*desktop-build*' })`,
    // The Host child process holds the disposable profile as its working directory.
    `$hosts = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*desktop-host*' })`,
    `foreach ($target in $shells + $hosts) { taskkill /T /F /PID $target.ProcessId 2>&1 | Out-Null }`,
  ].join('; ')
  await run('powershell', ['-NoProfile', '-Command', script], REPOSITORY_ROOT).catch(() => {})
  await new Promise(settle => setTimeout(settle, 1500))
}

/** Mount the Tavern bundles in the freshly generated disposable profile. */
function mountTavernBundles() {
  // 0.2 boots the Host from the durable home profile, not the regenerated
  // runtime project: the project only anchors package resolution.
  const profileDir = join(DEVELOPMENT_ROOT, 'home', 'profiles', 'desktop')
  mkdirSync(profileDir, { recursive: true })
  const manifestPath = join(profileDir, 'package.json')
  const manifest = existsSync(manifestPath)
    ? readJson(manifestPath)
    : { name: 'dsh-profile-desktop', private: true, dsh: { profile: { bundles: [] } } }
  const bundles = [...new Set([...(manifest.dsh?.profile?.bundles ?? BUILTIN_BUNDLES), ...TAVERN_BUNDLES])]
  const dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles } }
  writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, dsh }, undefined, 2)}\n`)
  // The disposable profile is regenerated on every start, so the better-sidebar
  // 0.2 version exemption the Web profile grants once must be re-granted here.
  const exemptionsPath = join(profileDir, 'compatibility.json')
  const exemptions = existsSync(exemptionsPath) ? readJson(exemptionsPath) : {}
  const dshVersion = readJson(join(REPOSITORY_ROOT, 'apps', 'cli', 'package.json')).version
  for (const name of TAVERN_BUNDLES) {
    const version = readJson(join(PROJECT_DIR, 'node_modules', ...name.split('/'), 'package.json')).version
    exemptions[`${name}@${version}`] = [...new Set([...(exemptions[`${name}@${version}`] ?? []), dshVersion])]
  }
  writeFileSync(exemptionsPath, `${JSON.stringify(exemptions, undefined, 2)}\n`)
  console.log(`desktop tavern: mounted ${TAVERN_BUNDLES.join(', ')} (compatibility exemptions granted)`)
}


async function launchElectron() {
  const electron = electronExecutable()
  const environment = {
    ...process.env,
    DSH_HOME: resolve(process.env.DSH_HOME ?? join(DEVELOPMENT_ROOT, 'home')),
    DSH_DESKTOP_PRIMARY_RUNTIME_DIR: process.env.DSH_DESKTOP_PRIMARY_RUNTIME_DIR ?? developmentRuntimeDirectory(),
    DSH_DESKTOP_HOST_INSPECT_PORT: process.env.DSH_DESKTOP_HOST_INSPECT_PORT ?? '9230',
    DSH_DESKTOP_NODE_BINARY: process.execPath,
    DSH_DESKTOP_OPEN_DEVTOOLS: process.env.DSH_DESKTOP_OPEN_DEVTOOLS ?? '0',
    ELECTRON_ENABLE_LOGGING: process.env.ELECTRON_ENABLE_LOGGING ?? '1',
  }
  console.log(`desktop tavern: DSH_HOME=${environment.DSH_HOME}`)
  await run(electron, [
    `--inspect=127.0.0.1:${process.env.DSH_DESKTOP_MAIN_INSPECT_PORT ?? '9229'}`,
    `--remote-debugging-port=${process.env.DSH_DESKTOP_RENDERER_DEBUG_PORT ?? '9222'}`,
    `--user-data-dir=${join(DEVELOPMENT_ROOT, 'electron-user-data')}`,
    APP_ROOT,
  ], APP_ROOT, environment)
}

async function main() {
  if (!process.argv.includes('--skip-build')) {
    await run(process.execPath, [process.env.npm_execpath, 'run', 'build'], REPOSITORY_ROOT)
    await run(process.execPath, [process.env.npm_execpath, 'run', 'build'], APP_ROOT)
  }
  const electron = electronExecutable()
  const release = {
    schemaVersion: 1,
    version: readJson(join(APP_ROOT, 'package.json')).version,
    hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
    // The Host child runs under Electron-as-Node, not the launcher's Node.
    nodeVersion: execFileSync(electron, ['-p', 'process.versions.node'],
      { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }).trim(),
    pnpmVersion: readJson(join(APP_ROOT, 'node_modules', 'pnpm', 'package.json')).version,
  }
  await stopRunningShell()
  prepareDevelopmentProject({
    projectDir: PROJECT_DIR,
    cliDir: join(REPOSITORY_ROOT, 'apps', 'cli'),
    hostDir: join(REPOSITORY_ROOT, 'apps', 'desktop-host'),
    dependencyDir: join(REPOSITORY_ROOT, 'node_modules', '.pnpm', 'node_modules'),
    release,
    target: resolveDesktopBuildTarget(),
  })
  mountTavernBundles()
  await preparePrimaryRuntime()
  await launchElectron()
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
