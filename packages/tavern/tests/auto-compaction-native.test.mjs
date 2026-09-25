import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveAgentCompaction } from '../tavern-plugin/lib/agent-compaction.js'
import { pathToFileURL } from 'node:url'
import { createInitializationNative } from './fixtures/conversation-initialization-native.mjs'
import { createAutoCompaction, installCompactionPolicy } from '../tavern-plugin/lib/domain/auto-compaction.js'
import { sessionEvents } from '../tavern-plugin/lib/domain/session-events.js'
const native = { skip: !process.env.DSH_BOOT_MODULE, timeout: 30000 }

test('real DSH: isolated joint schedule preserves queued user input and fixed system', native, async t => {
  const h = await createInitializationNative(process.env.DSH_BOOT_MODULE)
  t.after(() => h.dispose())
  const rows = [{ chat_metadata: {} }, { is_user: false, mes: '开场' }]
  for (let i = 0; i < 4; i++) rows.push({ is_user: true, mes: '查看环境' }, { is_user: false, mes: '花店旧事。'.repeat(180) })
  const opened = await h.importHistory({ ...h.input, operationId: 'auto-native', text: rows.map(JSON.stringify).join('\n') })
  await h.continueWithAgent()
  const boot = pathToFileURL(process.env.DSH_BOOT_MODULE)
  const { BasicCompactionEngine } = await import(new URL('../../dsh-compaction-basic/lib/index.js', boot))
  const engine = new BasicCompactionEngine(h.ctx, { auto: true })
  let chat = { id: 'joint', mode: 'story', sessionId: h.target.session.id, messages: [], timeline: { branchId: 'main', participants: {} } }, policy = { mode: 'manual' }
  const background = await h.ctx.agents.create({ sessionId: 'joint-background', agentOptions: { provider: 'initialization-fixture', model: 'text' } })
  t.after(() => background.dispose())
  // Isolate joint maintenance here; native safety routing is exercised below.
  const stop = installCompactionPolicy(engine, async (agent, trigger, signal, fallback, forced) => {
    if (agent === background.agent) return null
    await service.run(agent.session.id, { agent, signal, openTurnCompact: forced }); return null
  })
  t.after(stop)
  const service = createAutoCompaction({
    readChat: async () => structuredClone(chat), updateChat: async (_id, fn) => { chat = fn(structuredClone(chat)); return structuredClone(chat) },
    policy: async () => policy, activity: () => ({ phase: 'idle' }), exclusive: async (_id, fn) => fn(), pressure: async () => ({ percent: 90 }),
    checkpoint: async id => (id === chat.sessionId ? h.target.session : background.agent.session).seq,
    recover: async () => 'unknown', markBackground: async () => {},
    compact: async (id, side, options, signal) => side === 'foreground' ? options.openTurnCompact() : engine.compactNow(background.agent, signal)
  })
  background.agent.followup({ id: 'back-input', role: 'user', content: [{ type: 'text', text: '后台需保留的剧情状态。'.repeat(300) }], source: { kind: 'human' } })
  await background.agent.whenIdle()
  chat.timeline.participants.background = { sessionId: background.agent.session.id }
  const before = sessionEvents(h.target.session).length
  h.target.agent.followup({ id: 'input-' + h.requests.length, role: 'user', content: [{ type: 'text', text: '继续。' }], source: { kind: 'human' } })
  await h.target.agent.whenIdle()
  assert.equal(sessionEvents(h.target.session).filter(e => e.type === 'compaction/summary').length, 0)
  policy = { mode: 'percent', percent: 80 }
  const checkpoint = h.requests.length
  h.target.agent.followup({ id: 'input-' + h.requests.length, role: 'user', content: [{ type: 'text', text: '继续。' }], source: { kind: 'human' } })
  await h.target.agent.whenIdle()
  assert.equal(chat.contextCompaction.operation.status, 'completed')
  assert.ok(sessionEvents(h.target.session).some(e => e.type === 'compaction/summary'))
  assert.ok(sessionEvents(background.agent.session).some(e => e.type === 'compaction/summary'))
  assert.ok(sessionEvents(h.target.session).length > before)
  const request = h.requests.slice(checkpoint).filter(r => r.purpose !== 'compaction').at(-1)
  assert.ok(request.messages.some(m => m.content?.some(b => b.text === '继续。')), 'queued user message must reach the next real provider request')
  assert.match(request.system, /不可丢失的固定背景/)
})

// Exercise the shipped isolated preset group and the production service resolver.
test('real preset: foreground and background resolve their own isolated compaction engines', native, async t => {
  const h = await createInitializationNative(process.env.DSH_BOOT_MODULE)
  t.after(() => h.dispose())
  const boot = pathToFileURL(process.env.DSH_BOOT_MODULE)
  const { createScope, bindScopeParent } = await import(new URL('../../dsh-scope/lib/index.js', boot))
  const { mountPreset } = await import(new URL('../../dsh-agent-presets/lib/index.js', boot))
  const root = await mkdtemp(join(tmpdir(), 'tavern-compaction-preset-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  async function mount(name, agent) {
    const source = await readFile(new URL('../presets/' + name + '/agent.cordis.yml', import.meta.url), 'utf8')
    const group = source.match(/- id: compaction\n[\s\S]*$/)[0]
      .replace('dsh-tavern-plugin/compaction', new URL('../tavern-plugin/lib/agent-compaction.js', import.meta.url).href)
    const file = join(root, name + '.yml')
    await writeFile(file, group)
    const key = {}, scope = createScope(h.ctx, key)
    t.after(() => scope.dispose())
    await mountPreset(scope.ctx, { id: name, path: file })
    bindScopeParent(agent, key)
    return scope
  }
  await mount('tavern', h.target.agent)
  const background = await h.ctx.agents.create({ sessionId: 'isolated-background', agentOptions: { provider: 'initialization-fixture', model: 'text' } })
  t.after(() => background.dispose())
  await mount('tavern-background', background.agent)
  assert.equal(h.target.agent.ctx.get('compaction'), undefined, 'outer Agent context cannot see the isolated service')
  const foregroundEngine = await resolveAgentCompaction(h.ctx, h.target.agent)
  const backgroundEngine = await resolveAgentCompaction(h.ctx, background.agent)
  assert.notEqual(foregroundEngine, backgroundEngine)
  t.after(installCompactionPolicy(foregroundEngine, async () => null))
  t.after(installCompactionPolicy(backgroundEngine, async () => null))
  h.ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const engine = await resolveAgentCompaction(h.ctx, agent)
    await engine.compactIfNeeded(agent, 'pressure', signal)
    return next()
  }, { prepend: true })
  for (const agent of [h.target.agent, background.agent]) {
    agent.followup({ id: 'continue-' + agent.session.id, role: 'user', content: [{ type: 'text', text: '继续。'.repeat(1800) }], source: { kind: 'human' } })
    await agent.whenIdle()
    const events = sessionEvents(agent.session)
    assert.ok(events.some(e => e.type === 'assistant/message'))
    assert.equal(events.filter(e => e.type === 'turn/end' && e.data.reason.kind === 'error').length, 0)
    assert.equal(events.filter(e => e.type === 'compaction/summary').length, 0, 'test stub suppresses automatic compaction to isolate engine resolution')
    await (await resolveAgentCompaction(h.ctx, agent)).compactNow(agent, new AbortController().signal)
    assert.ok(sessionEvents(agent.session).some(e => e.type === 'compaction/summary'), 'explicit manual compression works inside the correct scope')
  }
})

test('real background loop recovers provider overflow and retains the pending candidate request', native, async t => {
  const { compactBackgroundIfNeeded } = await import('../tavern-plugin/lib/domain/background-compaction.js')
  const h = await createInitializationNative(process.env.DSH_BOOT_MODULE)
  t.after(() => h.dispose())
  const boot = pathToFileURL(process.env.DSH_BOOT_MODULE)
  const { BasicCompactionEngine } = await import(new URL('../../dsh-compaction-basic/lib/index.js', boot))
  const engine = new BasicCompactionEngine(h.ctx, { auto: true })
  let protectedRewind = false, rejectNext = false, rejected = 0
  t.after(installCompactionPolicy(engine, (agent, trigger, signal, fallback, forced) => compactBackgroundIfNeeded({
    trigger, forced, native: async () => null, pressure: async () => null
  }), { beforeRegion: async () => { protectedRewind = true } }))
  h.ctx.on('llm/stream', (request, next) => {
    if (request.purpose === 'compaction') assert.equal(protectedRewind, true)
    if (rejectNext && request.purpose !== 'compaction') {
      rejectNext = false; rejected++
      return (async function* () { yield { type: 'finish', reason: { kind: 'error', failure: { message: 'maximum context length 1048576; requested 1089015 (705015 messages, 384000 completion)', code: 'CONTEXT_WINDOW_EXCEEDED' } } } })()
    }
    return next()
  })
  const agent = h.target.agent
  agent.followup({ id: 'old-background', role: 'user', content: [{ type: 'text', text: '已有剧情与结算。'.repeat(800) }], source: { kind: 'human' } })
  await agent.whenIdle()
  rejectNext = true
  agent.followup({ id: 'candidate', role: 'user', content: [{ type: 'text', text: '请生成本轮候选项。' }], source: { kind: 'human' } })
  await agent.whenIdle()
  const events = sessionEvents(agent.session)
  assert.equal(rejected, 1)
  assert.ok(events.some(e => e.type === 'compaction/summary'))
  assert.equal(events.filter(e => e.type === 'turn/end').at(-1).data.reason.kind, 'completed')
  const request = h.requests.filter(r => r.purpose !== 'compaction').at(-1)
  assert.match(JSON.stringify(request.messages), /请生成本轮候选项/)
})

test('real background loop stops after the native overflow retry budget', native, async t => {
  const { compactBackgroundIfNeeded } = await import('../tavern-plugin/lib/domain/background-compaction.js')
  const h = await createInitializationNative(process.env.DSH_BOOT_MODULE)
  t.after(() => h.dispose())
  const boot = pathToFileURL(process.env.DSH_BOOT_MODULE)
  const { BasicCompactionEngine } = await import(new URL('../../dsh-compaction-basic/lib/index.js', boot))
  const engine = new BasicCompactionEngine(h.ctx, { auto: true })
  let protectedRewind = false, rejectNext = false, rejected = 0
  t.after(installCompactionPolicy(engine, (agent, trigger, signal, fallback, forced) => compactBackgroundIfNeeded({
    trigger, forced, native: async () => null, pressure: async () => null
  }), { beforeRegion: async () => { protectedRewind = true } }))
  h.ctx.on('llm/stream', (request, next) => {
    if (request.purpose === 'compaction') assert.equal(protectedRewind, true)
    if (rejectNext && request.purpose !== 'compaction') {
      rejected++
      return (async function* () { yield { type: 'finish', reason: { kind: 'error', failure: { message: 'maximum context length 1048576; requested 1089015 (705015 messages, 384000 completion)', code: 'CONTEXT_WINDOW_EXCEEDED' } } } })()
    }
    return next()
  })
  const agent = h.target.agent
  agent.followup({ id: 'old-background', role: 'user', content: [{ type: 'text', text: '已有剧情与结算。'.repeat(800) }], source: { kind: 'human' } })
  await agent.whenIdle()
  rejectNext = true
  agent.followup({ id: 'candidate', role: 'user', content: [{ type: 'text', text: '请生成本轮候选项。' }], source: { kind: 'human' } })
  await agent.whenIdle()
  const events = sessionEvents(agent.session)
  assert.equal(rejected, 2)
  assert.ok(events.some(e => e.type === 'compaction/summary'))
  assert.equal(events.filter(e => e.type === 'turn/end').at(-1).data.reason.kind, 'error')
})

for (const policy of [{ mode: 'manual' }, { mode: 'rounds', rounds: 100 }]) {
  test(`real foreground: ${policy.mode} schedule cannot suppress provider overflow recovery`, native, async t => {
    const { compactForegroundIfNeeded } = await import('../tavern-plugin/lib/domain/foreground-compaction.js')
    const h = await createInitializationNative(process.env.DSH_BOOT_MODULE)
    t.after(() => h.dispose())
    const { BasicCompactionEngine } = await import(new URL('../../dsh-compaction-basic/lib/index.js', pathToFileURL(process.env.DSH_BOOT_MODULE)))
    const engine = new BasicCompactionEngine(h.ctx, { auto: true })
    const chat = { id: 'test', mode: 'story', sessionId: h.target.session.id, messages: [] }
    const service = createAutoCompaction({
      readChat: async () => chat, updateChat: async (_id, fn) => fn(chat), policy: async () => policy,
      activity: () => { throw Error('must not wait for background settlement') },
      compact: () => { throw Error('must not enter joint maintenance') }
    })
    let rejectNext = false, rejected = 0, recorded = 0
    t.after(installCompactionPolicy(engine, (agent, trigger, signal, fallback, forced) => compactForegroundIfNeeded({
      trigger, native: () => trigger === 'context-overflow' ? fallback() : null, forced,
      pressure: async () => null, record: async () => { recorded++ },
      scheduled: () => service.run(agent.session.id, { agent, signal, openTurnCompact: forced })
    })))
    h.ctx.on('llm/stream', (request, next) => {
      if (rejectNext && request.purpose !== 'compaction') {
        rejectNext = false; rejected++
        return (async function* () { yield { type: 'finish', reason: { kind: 'error', failure: { message: 'context length exceeded', code: 'CONTEXT_WINDOW_EXCEEDED' } } } })()
      }
      return next()
    })
    const agent = h.target.agent
    agent.followup({ id: 'old', role: 'user', content: [{ type: 'text', text: '已有剧情。'.repeat(800) }], source: { kind: 'human' } })
    await agent.whenIdle()
    rejectNext = true
    agent.followup({ id: 'new', role: 'user', content: [{ type: 'text', text: '继续本轮剧情。' }], source: { kind: 'human' } })
    await agent.whenIdle()
    const events = sessionEvents(agent.session)
    assert.equal(rejected, 1); assert.equal(recorded, 1)
    assert.ok(events.some(event => event.type === 'compaction/summary'))
    assert.equal(events.filter(event => event.type === 'turn/end').at(-1).data.reason.kind, 'completed')
    assert.match(JSON.stringify(h.requests.filter(request => request.purpose !== 'compaction').at(-1).messages), /继续本轮剧情/)
  })
}

test('real foreground: native pressure keeps the priced recent tail instead of forcing zero retention', native, async t => {
  const { compactForegroundIfNeeded } = await import('../tavern-plugin/lib/domain/foreground-compaction.js')
  const h = await createInitializationNative(process.env.DSH_BOOT_MODULE)
  t.after(() => h.dispose())
  const { BasicCompactionEngine } = await import(new URL('../../dsh-compaction-basic/lib/index.js', pathToFileURL(process.env.DSH_BOOT_MODULE)))
  const engine = new BasicCompactionEngine(h.ctx, { auto: true })
  let enabled = false, recorded = 0
  t.after(installCompactionPolicy(engine, (agent, trigger, signal, fallback, forced) => enabled ? compactForegroundIfNeeded({
    trigger, native: fallback, forced, pressure: async () => null,
    record: async () => { recorded++ }, scheduled: async () => { throw Error('native protection should already run') }
  }) : null))
  const agent = h.target.agent
  for (let i = 0; i < 8; i++) {
    agent.followup({ id: 'seed-' + i, role: 'user', content: [{ type: 'text', text: `第${i}段旧剧情。`.repeat(200) }], source: { kind: 'human' } })
    await agent.whenIdle()
  }
  const measurement = h.ctx.tokenMeter.measure(agent.session)
  assert.ok(measurement.totalTokens >= 1600)
  let sum = 0; const kept = []
  for (const node of [...measurement.nodes].reverse()) {
    kept.push(node.seq); sum += node.tokens; if (sum >= 320) break
  }
  enabled = true
  agent.followup({ id: 'new-pressure', role: 'user', content: [{ type: 'text', text: '下一幕。' }], source: { kind: 'human' } })
  await agent.whenIdle()
  assert.equal(recorded, 1)
  assert.ok(kept.every(seq => agent.session.surface.nodes.includes(seq)), 'native 16% recent history remains verbatim')
  assert.equal(sessionEvents(agent.session).filter(event => event.type === 'turn/end').at(-1).data.reason.kind, 'completed')
})

test('real background: unknown extra budget does not suppress native pressure and rewind guard precedes summary', native, async t => {
  const { compactBackgroundIfNeeded } = await import('../tavern-plugin/lib/domain/background-compaction.js')
  const h = await createInitializationNative(process.env.DSH_BOOT_MODULE)
  t.after(() => h.dispose())
  const { BasicCompactionEngine } = await import(new URL('../../dsh-compaction-basic/lib/index.js', pathToFileURL(process.env.DSH_BOOT_MODULE)))
  const engine = new BasicCompactionEngine(h.ctx, { auto: true })
  let enabled = false, protectedCount = 0
  t.after(installCompactionPolicy(engine, (agent, trigger, signal, fallback, forced) => enabled
    ? compactBackgroundIfNeeded({ trigger, native: fallback, forced, pressure: async () => null }) : null,
  { beforeRegion: async () => { protectedCount++ } }))
  h.ctx.on('llm/stream', (request, next) => {
    if (request.purpose === 'compaction') assert.ok(protectedCount > 0)
    return next()
  })
  const agent = h.target.agent
  for (let i = 0; i < 8; i++) {
    agent.followup({ id: 'background-seed-' + i, role: 'user', content: [{ type: 'text', text: `第${i}段剧情与结算。`.repeat(200) }], source: { kind: 'human' } })
    await agent.whenIdle()
  }
  assert.equal(protectedCount, 0)
  assert.ok(h.ctx.tokenMeter.measure(agent.session).totalTokens >= 1600)
  enabled = true
  agent.followup({ id: 'next-background', role: 'user', content: [{ type: 'text', text: '继续结算。' }], source: { kind: 'human' } })
  await agent.whenIdle()
  assert.equal(protectedCount, 1)
  assert.ok(sessionEvents(agent.session).some(event => event.type === 'compaction/summary'))
  assert.equal(sessionEvents(agent.session).filter(event => event.type === 'turn/end').at(-1).data.reason.kind, 'completed')
})
