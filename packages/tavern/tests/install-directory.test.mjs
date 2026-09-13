import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const source = readFileSync(new URL('../install.sh', import.meta.url), 'utf8')
const selection = source.slice(source.indexOf('  # CLI directory selection:'), source.indexOf('  DSH_TAVERN_CLI_HOME=${DSH_ROOT}'))
test('CLI directory selection accepts explicit paths, refuses collisions and permits retry', { skip: process.platform === 'win32' }, t => {
  const root = mkdtempSync(path.join(tmpdir(), 'tavern-location-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const target = path.join(root, '中文 space')
  const run = () => spawnSync('sh', ['-ec', selection], { env: { ...process.env, DSH_TAVERN_CLI_HOME: target }, encoding: 'utf8' })
  mkdirSync(path.join(target, 'runtime'), { recursive: true })
  writeFileSync(path.join(target, 'runtime', 'keep'), 'user data')
  assert.notEqual(run().status, 0)
  assert.equal(readFileSync(path.join(target, 'runtime', 'keep'), 'utf8'), 'user data')
  rmSync(path.join(target, 'runtime'), { recursive: true })
  assert.equal(run().status, 0)
  mkdirSync(path.join(target, 'runtime'))
  assert.equal(run().status, 0)
  assert.equal(readFileSync(path.join(target, '.dsh-tavern-install-root'), 'utf8').trim(), 'cli-v1')
})
