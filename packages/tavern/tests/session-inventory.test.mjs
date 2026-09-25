import assert from 'node:assert/strict'
import test from 'node:test'
import { createSessionInventory } from '../tavern-plugin/lib/domain/session-inventory.js'

test('统计不加载冷会话、不读取正文，区分未知值与零并合并直接引用', async () => {
  const forbidden = () => { throw new Error('不得加载历史') }
  const live = { id: 'hot', seq: 12, get events() { forbidden() }, snapshotEvents: forbidden }
  const reads = []
  const inventory = createSessionInventory({
    persistence: { list: async () => [{ id: 'cold' }, { id: 'hot' }, { id: 'missing' }], load: forbidden, inspect: forbidden,
      locate: meta => ({ path: '/logs/' + meta.id }) },
    sessions: { list: () => [live], get: id => id === 'hot' ? live : undefined },
    agents: { get: id => id === 'hot' ? { phase: { kind: 'running' }, session: live } : undefined, resume: forbidden },
    references: async () => [{ sessionId: 'hot', chatId: 'c1', cardName: '角色', lastOpenedAt: 100 }, { sessionId: 'linked-only', chatId: 'c2', title: '待恢复' }],
    archived: () => ['cold'], fileStat: async path => { reads.push(path); if (path.endsWith('missing')) throw Object.assign(new Error(), { code: 'ENOENT' }); return { size: 0, mtimeMs: 200 } },
    memory: () => ({ rss: 1024, heapUsed: 512, private: 'secret' }), now: () => 300
  })
  const result = await inventory.read()
  const cold = result.rows.find(row => row.sessionId === 'cold')
  assert.equal(cold.loaded, false)
  assert.equal(cold.eventCount, null)
  assert.equal(cold.diskBytes, 0)
  assert.equal(cold.archived, true)
  assert.equal(result.rows[0].eventCount, 12)
  assert.equal(result.rows[0].references[0].title, '角色')
  assert.equal(result.totals.sessions, 4)
  assert.equal(result.totals.unknownDiskSize, 2)
  assert.equal(reads.length, 3)
  assert.doesNotMatch(JSON.stringify(result), /secret|\/logs\//)
})

test('并发统计只枚举一次，失败后可重新刷新', async () => {
  let calls = 0
  const inventory = createSessionInventory({
    persistence: { list: async () => { if (++calls === 1) throw new Error('不可用'); return [{ id: 'sqlite' }] } },
    sessions: { get() {} }, agents: { get() {} }, references: async () => []
  })
  const first = inventory.read(), second = inventory.read()
  assert.equal(first, second)
  await assert.rejects(first, /不可用/)
  const result = await inventory.read()
  assert.equal(calls, 2)
  assert.equal(result.rows[0].diskBytes, null)
  assert.equal(result.rows[0].archived, null)
})

test('仅通过会话头追溯后台归属，区分直接关联与父会话关联并终止循环', async () => {
  const forbidden = () => { throw new Error('不得加载历史') }
  const headers = [{ id: 'front' }, { id: 'background', parentSession: 'front' },
    { id: 'child', parentSession: 'background' }, { id: 'unknown', parentSession: 'absent' },
    { id: 'cycle-a', parentSession: 'cycle-b' }, { id: 'cycle-b', parentSession: 'cycle-a' }]
  const inventory = createSessionInventory({ persistence: { list: async () => headers, load: forbidden, inspect: forbidden },
    sessions: { get() {} }, agents: { get() {}, resume: forbidden },
    references: async () => [{ sessionId: 'front', chatId: 'game', title: '原来的游戏' }] })
  const rows = new Map((await inventory.read()).rows.map(row => [row.sessionId, row]))
  assert.equal(rows.get('front').references[0].relation, 'direct')
  assert.deepEqual(rows.get('background').references, [{ chatId: 'game', title: '原来的游戏', lastOpenedAt: null, relation: 'ancestor', viaSessionId: 'front' }])
  assert.deepEqual(rows.get('child').references, rows.get('background').references)
  assert.equal(rows.get('child').parentSessionId, 'background')
  for (const id of ['unknown', 'cycle-a', 'cycle-b']) assert.deepEqual(rows.get(id).references, [])
})

test('深层父链不递归加载；子会话自身直接关联优先，实时会话头补齐父关系', async () => {
  const headers = Array.from({ length: 12000 }, (_, i) => ({ id: String(i), ...(i < 11999 ? { parentSession: String(i + 1) } : {}) }))
  const inventory = createSessionInventory({ persistence: { list: async () => headers },
    sessions: { list: () => [{ id: 'live', header: { parentSession: '0' } }], get() {} }, agents: { get() {} },
    references: async () => [{ sessionId: '11999', chatId: 'root', title: '根游戏' }, { sessionId: '3', chatId: 'own', title: '独立游戏' }] })
  const rows = new Map((await inventory.read()).rows.map(row => [row.sessionId, row]))
  assert.equal(rows.get('0').references[0].chatId, 'own')
  assert.equal(rows.get('0').references[0].viaSessionId, '3')
  assert.equal(rows.get('3').references[0].relation, 'direct')
  assert.equal(rows.get('4').references[0].chatId, 'root')
  assert.equal(rows.get('live').references[0].chatId, 'own')
})

test('当前绑定优先于新旧时间和运行状态，独立后台或旧索引不冒充历史', async () => {
  const headers = [{ id: 'front' }, ...['old-current', 'new-history', 'image'].map(id => ({ id, parentSession: 'front', agentPreset: 'tavern-background' }))]
  const inventory = createSessionInventory({ persistence: { list: async () => headers }, sessions: { get() {} }, agents: { get() {} },
    references: async () => [{ sessionId: 'front', chatId: 'game', title: '游戏', backgroundSessionId: 'old-current', backgroundHistoryIds: ['new-history'] }] })
  const rows = new Map((await inventory.read()).rows.map(row => [row.sessionId, row]))
  assert.equal(rows.get('old-current').backgroundState, 'current')
  assert.equal(rows.get('new-history').backgroundState, 'historical')
  assert.equal(rows.get('image').backgroundState, 'unknown')
  assert.equal(rows.get('new-history').references[0].title, '游戏')
})
