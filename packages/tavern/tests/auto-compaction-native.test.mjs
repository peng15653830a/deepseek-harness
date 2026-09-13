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

test('real DSH: manual policy suppresses host auto; joint compaction preserves queued user input and fixed system', native, async t => {
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
    assert.equal(events.filter(e => e.type === 'compaction/summary').length, 0, 'manual default suppresses native pressure compaction')
    await (await resolveAgentCompaction(h.ctx, agent)).compactNow(agent, new AbortController().signal)
    assert.ok(sessionEvents(agent.session).some(e => e.type === 'compaction/summary'), 'explicit manual compression works inside the correct scope')
  }
})
