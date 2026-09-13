import test from 'node:test'
import assert from 'node:assert/strict'
import { createAutoCompaction, compactionPolicy, installCompactionPolicy } from '../tavern-plugin/lib/domain/auto-compaction.js'
function fixture() {
  let chat = { id: 'chat', mode: 'story', sessionId: 'front', messages: [], timeline: { branchId: 'main', participants: { background: { sessionId: 'back' } } } }
  let policy = { mode: 'manual' }, activity = { phase: 'idle' }, pressure = 0, fail = '', evidence = 'succeeded'
  const calls = [], deps = {
    readChat: async () => structuredClone(chat), updateChat: async (_id, fn) => { chat = fn(structuredClone(chat)); return structuredClone(chat) },
    policy: async () => policy, activity: () => activity, pressure: async () => pressure === null ? null : { percent: pressure },
    exclusive: async (_id, fn) => fn(), checkpoint: async () => 7, recover: async () => evidence, markBackground: async () => {},
    compact: async (id, side) => { calls.push(side); if (fail === side) throw new Error('fixture failure'); return { message: 'done' } }
  }
  let service = createAutoCompaction(deps)
  return { calls, deps, get chat() { return chat }, set policy(v) { policy = v }, set activity(v) { activity = v }, set pressure(v) { pressure = v }, set fail(v) { fail = v },
    run: options => service.run('front', options), round(n) { chat.messages.push({ role: 'assistant', turn: n }) },
    restart() { service = createAutoCompaction(deps) }, blocked: () => service.blocked(chat) }
}
test('default manual never follows native pressure; settings validate bounds', async () => {
  assert.equal(compactionPolicy().mode, 'manual')
  for (const policy of [{ mode: 'bad' }, { rounds: 0 }, { percent: 100 }, { rounds: 1.5 }]) assert.throws(() => compactionPolicy(policy))
  const h = fixture(); h.pressure = 100; h.round(1); await h.run(); assert.deepEqual(h.calls, [])
})
test('round mode counts distinct completed story turns; manual success resets baseline', async () => {
  const h = fixture(); h.policy = { mode: 'rounds', rounds: 2 }; await h.run()
  h.round(1); h.round(1); h.chat.messages.push({ role: 'assistant', turn: 90, greeting: true }); await h.run(); assert.equal(h.calls.length, 0)
  h.round(2); await h.run(); assert.deepEqual(h.calls, ['foreground', 'background'])
  h.round(3); await h.run({ manual: true }); h.round(4); await h.run(); assert.equal(h.calls.length, 4)
  h.round(5); await h.run(); assert.equal(h.calls.length, 6)
})
test('percent mode, unknown capacity, no-progress suppression and branch reset', async () => {
  const h = fixture(); h.policy = { mode: 'percent', percent: 80 }; h.pressure = null; await h.run(); assert.match(h.chat.contextCompaction.warning, /容量/)
  h.pressure = 79; await h.run(); assert.equal(h.calls.length, 0)
  h.pressure = 80; await h.run(); assert.equal(h.calls.length, 2)
  await h.run(); assert.equal(h.calls.length, 2)
  h.chat.timeline.branchId = 'fork'; h.policy = { mode: 'rounds', rounds: 1 }; await h.run(); assert.equal(h.calls.length, 2)
  h.round(1); await h.run(); assert.equal(h.calls.length, 4)
})
test('waits for settlement without blocking it; duplicate automatic calls share one operation', async () => {
  const h = fixture(); h.policy = { mode: 'rounds', rounds: 1 }; await h.run(); h.round(1); h.activity = { phase: 'pending' }
  const a = h.run(), b = h.run()
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(h.blocked(), false); assert.equal(h.calls.length, 0)
  h.activity = { phase: 'idle' }; await Promise.all([a, b]); assert.deepEqual(h.calls, ['foreground', 'background'])
})
test('partial failure persists across restart, manual retry only repeats failed side', async () => {
  const h = fixture(); h.policy = { mode: 'rounds', rounds: 1 }; await h.run(); h.round(1); h.fail = 'background'; await h.run()
  assert.equal(h.chat.contextCompaction.operation.status, 'partial'); h.restart(); h.fail = ''; await h.run(); assert.equal(h.calls.length, 2)
  await h.run({ manual: true }); assert.deepEqual(h.calls, ['foreground', 'background', 'background'])
})
test('restart recovers a dispatched successful foreground from native evidence without reissuing it', async () => {
  const h = fixture(); await h.run(); h.chat.contextCompaction.operation = { id: 'old', status: 'running', foregroundSessionId: 'front', backgroundSessionId: 'back', foreground: { status: 'dispatching', before: 7 }, background: { status: 'pending' } }
  h.restart(); await h.run(); assert.deepEqual(h.calls, ['background']); assert.equal(h.chat.contextCompaction.operation.status, 'completed')
})
test('scoped native policy preserves non-Tavern behavior and restores on disposal', async () => {
  const calls = [], engine = { async compactIfNeeded(agent, trigger) { calls.push(trigger); return 'native' } }, original = engine.compactIfNeeded
  const stop = installCompactionPolicy(engine, (agent, trigger, signal, fallback, force) => agent.id === 'tavern' ? null : fallback())
  assert.equal(await engine.compactIfNeeded({ id: 'tavern' }, 'pressure'), null)
  assert.equal(await engine.compactIfNeeded({ id: 'other' }, 'pressure'), 'native'); assert.deepEqual(calls, ['pressure']); stop(); assert.equal(engine.compactIfNeeded, original)
})

test('resumes pending settlement after restart and allows compression after a failed settlement', async () => {
  const h = fixture(); h.activity = { role: 'settlement', phase: 'pending' }
  let settled = 0
  h.deps.settle = async () => { settled++; h.activity = { role: 'settlement', phase: 'failed' } }
  await h.run({ manual: true })
  assert.equal(settled, 1)
  assert.deepEqual(h.calls, ['foreground', 'background'])
  assert.equal(h.chat.contextCompaction.operation.status, 'completed')
})

test('queued foreground input defers idle compression and retries at pre-step', async () => {
  const h = fixture(); h.policy = { mode: 'rounds', rounds: 1 }; await h.run(); h.round(1)
  const compact = h.deps.compact
  h.deps.compact = async (id, side, options) => {
    if (side === 'foreground' && !options.openTurnCompact) throw Object.assign(new Error('busy'), { code: 'busy' })
    return compact(id, side)
  }
  const idle = h.run(), preStep = h.run({ openTurnCompact: () => {} })
  assert.equal((await idle).status, 'deferred')
  assert.equal((await preStep).status, 'completed')
  assert.deepEqual(h.calls, ['foreground', 'background'])
})
