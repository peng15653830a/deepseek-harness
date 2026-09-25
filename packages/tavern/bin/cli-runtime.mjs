import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { adaptedDshVersion } from './dsh-compatibility.mjs'

export function cliRuntimeCommand(root, platform = process.platform) {
  return platform === 'win32' ? path.join(root, 'dsh.cmd') : path.join(root, 'bin', 'dsh')
}

// Validate the private CLI before reuse; never search PATH for a global DSH.
export function healthyCliRuntime(root, platform = process.platform) {
  try {
    const packageFile = path.join(root, platform === 'win32' ? 'node_modules/@deepseek-ai/dsh/package.json' : 'lib/node_modules/@deepseek-ai/dsh/package.json')
    const pkg = JSON.parse(readFileSync(packageFile, 'utf8'))
    const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.dsh
    if (pkg.version !== adaptedDshVersion || !bin || !existsSync(cliRuntimeCommand(root, platform))) return false
    const result = spawnSync(process.execPath, [path.resolve(path.dirname(packageFile), bin), '--version'], {
      encoding: 'utf8', timeout: 15000, windowsHide: true,
    })
    return !result.error && result.status === 0 && result.stdout.trim() === adaptedDshVersion
  } catch { return false }
}

export function installCliRuntime({ root, run, platform = process.platform, force = process.env.DSH_TAVERN_REINSTALL_RUNTIME === '1' }) {
  if (!force && healthyCliRuntime(root, platform)) {
    return { command: cliRuntimeCommand(root, platform), reused: true, commit() {}, rollback() {} }
  }
  mkdirSync(path.dirname(root), { recursive: true })
  const staging = mkdtempSync(`${root}.install-`)
  const backup = `${staging}.previous`
  let promoted = false
  let backedUp = false
  let settled = false
  try {
    run('npm', ['install', '--global', '--prefix', staging, '--registry', process.env.DSH_TAVERN_NPM_REGISTRY || 'https://registry.npmmirror.com', `@deepseek-ai/dsh@${adaptedDshVersion}`])
    const packageFile = platform === 'win32'
      ? path.join(staging, 'node_modules/@deepseek-ai/dsh/package.json')
      : path.join(staging, 'lib/node_modules/@deepseek-ai/dsh/package.json')
    if (JSON.parse(readFileSync(packageFile, 'utf8')).version !== adaptedDshVersion || !existsSync(cliRuntimeCommand(staging, platform))) {
      throw new Error('下载的独立 DSH 版本或入口不正确。')
    }
    if (existsSync(root)) { renameSync(root, backup); backedUp = true }
    renameSync(staging, root)
    promoted = true
    return {
      command: cliRuntimeCommand(root, platform),
      commit() { settled = true; if (backedUp) rmSync(backup, { recursive: true, force: true }) },
      rollback() {
        if (settled) return
        settled = true
        rmSync(root, { recursive: true, force: true })
        if (backedUp) renameSync(backup, root)
      },
    }
  } catch (error) {
    if (!promoted && backedUp) renameSync(backup, root)
    rmSync(staging, { recursive: true, force: true })
    throw error
  }
}

// Copy only a previous CLI installation, never adopt Desktop/DSHA data.
// Originals remain intact; a completed snapshot is never recopied on repair.
export function migrateCliHome({ source, target }) {
  if (path.resolve(source) === path.resolve(target)) return false
  const marker = path.join(target, '.cli-home-migrated.json')
  if (existsSync(marker)) return false
  const manifestFile = path.join(source, 'profiles/tavern/package.json')
  if (!existsSync(manifestFile)) return false
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
  if (manifest.dshTavern?.host !== 'cli') return false
  if (existsSync(path.join(source, 'logs/tavern.pid.json'))) {
    const launcher = path.join(manifest.dshTavern.source || '', 'bin/dsh-tavern.mjs')
    if (!existsSync(launcher)) throw new Error('请先停止旧 CLI 酒馆，再迁移数据；找不到旧启动器。')
    const stopped = spawnSync(process.execPath, [launcher, 'stop'], {
      stdio: 'inherit', env: { ...process.env, DSH_HOME: source, DSH_TAVERN_CLI_HOME: source, DSH_TAVERN_RUNTIME_HOST: 'cli' },
    })
    if (stopped.error || stopped.status !== 0) throw new Error('停止旧 CLI 失败，尚未复制数据。请先停止旧酒馆后重试。')
  }
  mkdirSync(target, { recursive: true })
  const entries = ['profile-data/tavern', 'settings.yaml', '.credentials.yaml', '.openai-codex-auth.json', '.agent-presets', 'attachments']
  // Only copy configuration files, not host dependency links/node_modules.
  entries.push('profiles/tavern/package.json', 'profiles/tavern/cordis.patch.yml')
  for (const entry of entries) {
    const from = path.join(source, entry), to = path.join(target, entry)
    if (!existsSync(from) || existsSync(to)) continue
    mkdirSync(path.dirname(to), { recursive: true })
    const staging = `${to}.migration-${process.pid}`
    try {
      cpSync(from, staging, { recursive: true, dereference: true })
      renameSync(staging, to)
    } finally { rmSync(staging, { recursive: true, force: true }) }
  }
  writeFileSync(marker, JSON.stringify({ source, migratedAt: new Date().toISOString() }) + '\n')
  return true
}
