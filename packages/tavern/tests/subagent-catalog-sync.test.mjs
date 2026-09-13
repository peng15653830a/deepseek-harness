import test from 'node:test'
import assert from 'node:assert/strict'
import { helperClient } from './fixtures/helper-host-harness.mjs'
const tick = () => new Promise(resolve => setImmediate(resolve))
test('新增运行中的代理后刷新已打开目录，目录更新不会形成刷新循环', async () => {
  const snapshot = { byId: { a: { id: 'a', origin: 'subagent', parentId: 'parent', running: false } }, subagentsByParent: { parent: { state: 'ready', entries: [] } } }
  let changed; const calls = []
  const stop = helperClient.syncTavernSubagentCatalogs({ list: { getSnapshot: () => snapshot, subscribe(fn) { changed = fn; return () => {} } }, refreshSubagents(id) { calls.push(id); changed() } })
  await tick(); assert.equal(calls.length, 1)
  snapshot.byId.b = { id: 'b', origin: 'subagent', parentId: 'parent', running: true }
  changed(); await tick(); assert.equal(calls.length, 2)
  changed(); await tick(); assert.equal(calls.length, 2)
  snapshot.byId.b.running = false; changed(); await tick(); assert.equal(calls.length, 3)
  stop(); snapshot.byId.b.running = true; changed(); await tick(); assert.equal(calls.length, 3)
})
