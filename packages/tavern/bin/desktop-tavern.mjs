/**
 * Launch the unpackaged Electron desktop shell with the Tavern plugin bundles mounted.
 *
 * The desktop development launcher regenerates its disposable profile on every start and
 * mounts only the two built-in bundles, so this wrapper re-applies the Tavern bundle set
 * after that preparation and before Electron starts. The desktop host serves those
 * plugins' HTTP surfaces through its own transport (see the web rows it keeps mounted).
 *
 * Usage: node_modules/.bin/tsx packages/tavern/bin/desktop-tavern.mjs [--skip-build]
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { DESKTOP_HOST_PROTOCOL_VERSION } from '../../../apps/desktop/src/host-protocol.ts'
import { prepareDevelopmentProject } from '../../../apps/desktop/scripts/development-project.ts'

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
  const escaped = APP_ROOT.replace(/\\/g, '\\\\')
  const script = [
    `$shells = @(Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*${escaped}*' })`,
    // The Host child process holds the disposable profile as its working directory.
    `$hosts = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*desktop-host*' })`,
    `foreach ($target in $shells + $hosts) { taskkill /T /F /PID $target.ProcessId 2>&1 | Out-Null }`,
  ].join('; ')
  await run('powershell', ['-NoProfile', '-Command', script], REPOSITORY_ROOT).catch(() => {})
  await new Promise(settle => setTimeout(settle, 1500))
}

/** Mount the Tavern bundles in the freshly generated disposable profile. */
function mountTavernBundles() {
  const manifestPath = join(PROJECT_DIR, 'package.json')
  const manifest = readJson(manifestPath)
  const dependencies = { ...(manifest.dependencies ?? {}) }
  for (const name of TAVERN_BUNDLES) {
    const installed = join(PROJECT_DIR, 'node_modules', ...name.split('/'), 'package.json')
    if (!existsSync(installed)) throw new Error(`desktop tavern: ${name} is missing from the development profile; run pnpm install`)
    const version = readJson(installed).version
    if (typeof version !== 'string' || version === '') throw new Error(`desktop tavern: ${name} has no version`)
    dependencies[name] = version
  }
  const bundles = [...BUILTIN_BUNDLES, ...TAVERN_BUNDLES]
  const dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles } }
  writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, dependencies, dsh }, undefined, 2)}\n`)
  console.log(`desktop tavern: mounted ${TAVERN_BUNDLES.join(', ')}`)
}

async function launchElectron() {
  const environment = {
    ...process.env,
    DSH_HOME: resolve(process.env.DSH_HOME ?? join(DEVELOPMENT_ROOT, 'home')),
    DSH_DESKTOP_HOST_INSPECT_PORT: process.env.DSH_DESKTOP_HOST_INSPECT_PORT ?? '9230',
    DSH_DESKTOP_NODE_BINARY: process.execPath,
    DSH_DESKTOP_OPEN_DEVTOOLS: process.env.DSH_DESKTOP_OPEN_DEVTOOLS ?? '0',
    ELECTRON_ENABLE_LOGGING: process.env.ELECTRON_ENABLE_LOGGING ?? '1',
  }
  console.log(`desktop tavern: DSH_HOME=${environment.DSH_HOME}`)
  await run(electronExecutable(), [
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
  const release = {
    schemaVersion: 1,
    version: readJson(join(APP_ROOT, 'package.json')).version,
    hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
    nodeVersion: process.versions.node,
    pnpmVersion: readJson(join(APP_ROOT, 'node_modules', 'pnpm', 'package.json')).version,
  }
  await stopRunningShell()
  prepareDevelopmentProject({
    projectDir: PROJECT_DIR,
    cliDir: join(REPOSITORY_ROOT, 'apps', 'cli'),
    hostDir: join(REPOSITORY_ROOT, 'apps', 'desktop-host'),
    dependencyDir: join(REPOSITORY_ROOT, 'node_modules', '.pnpm', 'node_modules'),
    release,
  })
  mountTavernBundles()
  await launchElectron()
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
