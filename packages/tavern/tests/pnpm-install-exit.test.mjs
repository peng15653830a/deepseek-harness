import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runtimeEnvironment } from '../bin/launcher-environment.mjs'

test('installer subprocesses disable background pnpm version checks without changing the parent environment', () => {
  const before = process.env.pnpm_config_update_notifier
  assert.equal(runtimeEnvironment().pnpm_config_update_notifier, 'false')
  assert.equal(process.env.pnpm_config_update_notifier, before)
})

test('all bootstrap installers suppress pnpm version checks and PowerShell restores its caller', async () => {
  const unix = await readFile(new URL('../install.sh', import.meta.url), 'utf8')
  const windows = await readFile(new URL('../install.ps1', import.meta.url), 'utf8')
  assert.match(unix, /export pnpm_config_update_notifier=false/)
  assert.match(windows, /\$PreviousPnpmUpdateNotifier = \$env:pnpm_config_update_notifier/)
  assert.match(windows, /\$env:pnpm_config_update_notifier = 'false'/)
  assert.match(windows, /\$env:pnpm_config_update_notifier = \$PreviousPnpmUpdateNotifier/)
})

// Supply an installed pnpm CLI entry; no packages are fetched or installed globally.
test('real pnpm exits after Done even when the registry never answers version checks', { skip: !process.env.TAVERN_PNPM_ENTRY }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'tavern-pnpm-exit-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'package.json'), '{"name":"exit-probe","version":"1.0.0"}')
  const requests = [], server = createServer(req => requests.push(req.url))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) })
  const env = runtimeEnvironment(); delete env.CI
  if (process.env.TAVERN_PNPM_RUNTIME) env.ELECTRON_RUN_AS_NODE = '1'
  const child = spawn(process.env.TAVERN_PNPM_RUNTIME || process.execPath, [...(process.env.TAVERN_PNPM_PRELOAD ? ['--import', process.env.TAVERN_PNPM_PRELOAD] : []), process.env.TAVERN_PNPM_ENTRY, 'install', '--ignore-scripts', '--lockfile=false',
    '--registry=http://127.0.0.1:' + server.address().port, '--config.state-dir=' + join(root, 'state'), '--config.fetch-timeout=600000'], { cwd: root, env })
  let output = '', timedOut = false
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 12000)
  t.after(() => { clearTimeout(timer); if (child.exitCode === null) child.kill('SIGKILL') })
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve) })
  clearTimeout(timer)
  assert.equal(timedOut, false, output)
  assert.equal(code, 0, output)
  assert.match(output, /Done in/)
  assert.deepEqual(requests, [])
})
