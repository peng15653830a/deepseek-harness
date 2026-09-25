import assert from 'node:assert/strict'
import test from 'node:test'
import { createBackgroundAgentSessions } from '../tavern-plugin/lib/background-agent-sessions.js'

function deferred() { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
function harness(t, extra = {}) {
  let time = 0, sequence = 0
  const disk = new Map(), live = new Map(), calls = []
  async function handle(id, session) {
    live.set(id, session)
    return { agent: { session }, async dispose() { calls.push(['dispose', id]); live.delete(id) } }
  }
  const runner = createBackgroundAgentSessions({
    now: () => time, residentIdleMs: 1000, maxResidentSessions: 2, id: () => `idle-${++sequence}`,
    agents: {
      get: id => id.startsWith('parent') ? { id, session: { header: {} } } : undefined,
      create: async ({ sessionId, meta }) => {
        calls.push(['create', sessionId])
        return handle(sessionId, { id: sessionId, header: meta, events: [], append(type, data) { this.events.push({ type, data }) } })
      },
      resume: async ({ resumeSessionId }) => {
        calls.push(['resume', resumeSessionId])
        const saved = structuredClone(disk.get(resumeSessionId))
        assert.ok(saved, 'release must persist before resume')
        return handle(resumeSessionId, { ...saved, append(type, data) { this.events.push({ type, data }) } })
      }
    },
    flushSession: async session => {
      await extra.flush?.()
      disk.set(session.id, structuredClone({ id: session.id, header: session.header, events: session.events }))
    },
    compactAgent: async () => extra.compact?.(),
    ...extra.options
  }, {
    setup: () => () => {},
    execute: async ({ agent, traceSessionId }, input) => {
      await extra.work?.(input)
      agent.session.append('system/message', { text: input.text || 'task' })
      return traceSessionId
    }
  })
  t.after(() => runner.dispose())
  return { runner, live, disk, calls, tick: n => { time += n }, run: (parent = 'parent-a', text) => runner.run({ sessionId: parent, task: 'candidate', persistent: true, selection: { provider: 'test', model: 'test' }, text }) }
}

test('idle release clears references and restores the same session with its history', async t => {
  const h = harness(t)
  const id = await h.run('parent-a', 'first')
  h.tick(999); await h.runner.reapIdle(); assert.equal(h.runner.owns(id), true)
  h.tick(1); await h.runner.reapIdle()
  assert.equal(h.live.size, 0)
  assert.equal(h.runner.requestSession(id), null)
  assert.equal(h.runner.requestContext(id), null)
  assert.equal(await h.run('parent-a', 'second'), id)
  assert.deepEqual(h.live.get(id).events.filter(e => e.type === 'system/message').map(e => e.data.text), ['first', 'second'])
  assert.deepEqual(h.calls.map(c => c[0]), ['create', 'dispose', 'resume'])
})

test('resident cap evicts least recently used idle session', async t => {
  const h = harness(t)
  const a = await h.run(); h.tick(1)
  const b = await h.run('parent-b'); h.tick(1)
  await h.run(); h.tick(1)
  const c = await h.run('parent-c')
  await h.runner.reapIdle()
  assert.equal(h.runner.owns(a), true); assert.equal(h.runner.owns(b), false); assert.equal(h.runner.owns(c), true)
})

test('new work waits for in-progress release then resumes without losing history', async t => {
  const entered = deferred(), gate = deferred()
  const h = harness(t, { flush: async () => { entered.resolve(); await gate.promise } })
  const id = await h.run(); h.tick(1000)
  const reaping = h.runner.reapIdle(); await entered.promise
  const next = h.run()
  assert.equal(h.calls.filter(c => c[0] === 'resume').length, 0)
  gate.resolve(); await reaping
  assert.equal(await next, id)
  assert.equal(h.live.get(id).events.filter(e => e.type === 'system/message').length, 2)
})

test('running work and compaction are protected from idle eviction', async t => {
  const gate = deferred(), entered = deferred(), compact = deferred()
  let block = false
  const h = harness(t, { work: async () => { if (block) { entered.resolve(); await gate.promise } }, compact: () => compact.promise })
  const id = await h.run(); block = true
  const running = h.run(); await entered.promise
  h.tick(2000); await h.runner.reapIdle(); assert.equal(h.runner.owns(id), true)
  gate.resolve(); await running
  const compacting = h.runner.compact({ sessionId: id })
  h.tick(2000); await h.runner.reapIdle(); assert.equal(h.runner.owns(id), true)
  compact.resolve(); await compacting
  await h.runner.reapIdle(); assert.equal(h.runner.owns(id), true)
  h.tick(1000); await h.runner.reapIdle(); assert.equal(h.runner.owns(id), false)
})

test('failed persistence retains instance and backs off before retry', async t => {
  let fail = true, attempts = 0
  const h = harness(t, { flush: async () => { attempts++; if (fail) throw new Error('disk unavailable') } })
  const id = await h.run(); h.tick(1000)
  await h.runner.reapIdle(); assert.equal(h.runner.owns(id), true)
  await h.runner.reapIdle(); assert.equal(attempts, 1)
  fail = false; h.tick(60000); await h.runner.reapIdle()
  assert.equal(h.runner.owns(id), false); assert.equal(attempts, 2)
})

test('automatic timer releases idle handles and shutdown rejects subsequent tasks', async t => {
  const h = harness(t, { options: { now: Date.now, residentIdleMs: 10 } })
  const id = await h.run()
  for (let i = 0; i < 100 && h.runner.owns(id); i++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(h.runner.owns(id), false)
  await h.runner.dispose()
  await assert.rejects(h.run(), /已关闭/)
})
