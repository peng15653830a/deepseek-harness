import test from 'node:test'
import assert from 'node:assert/strict'
import { Session } from './fixtures/dsh-session-host.mjs'
import { appendSessionEvent, sessionEvents } from '../tavern-plugin/lib/domain/session-events.js'
import { replaceSessionSurface } from '../tavern-plugin/lib/domain/session-surface-mutations.js'
import { worldbookSnapshot } from '../tavern-plugin/lib/domain/worldbook-snapshot.js'
import { createForegroundFrameSessionAdapter } from '../tavern-plugin/lib/domain/foreground-frame-session-adapter.js'
import { createForegroundFrameBuilder } from '../tavern-plugin/lib/domain/agent-input-frame.js'
import { retireForegroundFrames } from '../tavern-plugin/lib/domain/foreground-frame-retirement.js'
import { worldbookPlacement } from '../tavern-plugin/lib/domain/worldbook-placement.js'

function append(session, text) {
  const snapshot = worldbookSnapshot(session, text)
  if (!snapshot) return null
  return appendSessionEvent(session, 'user/message', { id: crypto.randomUUID(), role: 'user',
    content: [{ type: 'text', text: snapshot.rendered }], source: { kind: 'plugin', plugin: 'dsh-tavern', worldbookSnapshot: snapshot } }, { surfaceOp: 'append' })
}
test('快照比较最终文本，相同不追加、变化追加、清空仅失效一次；准备不消耗快照', () => {
  const session = Session.create('snapshots')
  assert.equal(worldbookSnapshot(session, ''), null)
  assert.deepEqual(worldbookSnapshot(session, '晴'), worldbookSnapshot(session, '晴'))
  append(session, '晴')
  const prefix = structuredClone(session.deriveMessages())
  assert.equal(append(session, '晴'), null)
  append(session, '雨')
  assert.deepEqual(session.deriveMessages().slice(0, prefix.length), prefix)
  assert.match(append(session, '').data.content[0].text, /全部失效/)
  assert.equal(append(session, ''), null)
  assert.ok(worldbookSnapshot(session, '晴'))
})
test('恢复与分支读取自己的有效历史；回退和压缩后不会误用已隐藏快照', () => {
  const session = Session.create('snapshot-restore')
  append(session, '晴')
  const checkpoint = structuredClone(sessionEvents(session))
  const rain = append(session, '雨')
  const restored = Session.create(session.id, JSON.parse(JSON.stringify(sessionEvents(session))), session.header)
  assert.equal(worldbookSnapshot(restored, '雨'), null)
  const branch = Session.create('snapshot-branch', checkpoint, { ...session.header, id: 'snapshot-branch' })
  assert.equal(worldbookSnapshot(branch, '晴'), null)
  assert.ok(worldbookSnapshot(branch, '雨'))
  replaceSessionSurface(session, 'user/message', { id: 'rewind', role: 'user', content: [], source: { kind: 'plugin', plugin: 'dsh-tavern' } },
    { start: rain.seq, end: rain.seq, sourceEventSeqs: [rain.seq] })
  assert.equal(worldbookSnapshot(session, '晴'), null)
  const nodes = [...session.surface.nodes]
  replaceSessionSurface(session, 'user/message', { id: 'summary', role: 'user', content: [{ type: 'text', text: '故事摘要' }], source: { kind: 'plugin', plugin: 'dsh-tavern' } },
    { start: nodes[0], end: nodes.at(-1), sourceEventSeqs: nodes })
  assert.ok(worldbookSnapshot(session, '晴'))
})
test('前台快照独立于短期指引，清理指引后仍保留；下一轮同值不重发', () => {
  const session = Session.create('snapshot-frame')
  const adapter = createForegroundFrameSessionAdapter()
  function prepare(turn, text) {
    const frame = createForegroundFrameBuilder().build({ chatId: 'chat', branchId: 'branch', basedOnRevision: turn, operationId: 'op-' + turn, turn,
      inputs: [{ kind: 'foreground.user-input', sourceText: '继续' }, { kind: 'foreground.writing-rules', text: '本轮规则' },
        { kind: 'foreground.active-worldbook', text }] })
    const result = adapter.append({ session, messages: [], frame, step: 1 })
    for (const message of result.messages) appendSessionEvent(session, 'user/message', message, { surfaceOp: 'append' })
    return result.messages
  }
  assert.equal(prepare(1, '<天气>晴</天气>').length, 2)
  retireForegroundFrames(session)
  assert.match(JSON.stringify(session.deriveMessages()), /<天气>晴/)
  assert.equal(prepare(2, '<天气>晴</天气>').length, 1)
  assert.equal(prepare(3, '<天气>雨</天气>').length, 2)
  assert.match(prepare(4, '')[0].content[0].text, /全部失效/)
})
test('前后台快照互不干扰；后台任务内嵌快照也能去重', () => {
  const front = Session.create('front'), back = Session.create('back')
  append(front, '晴')
  const snapshot = worldbookSnapshot(back, '晴')
  assert.ok(snapshot)
  appendSessionEvent(back, 'user/message', { id: 'task', role: 'user', content: [{ type: 'text', text: snapshot.rendered + '\n生成候选项' }],
    source: { kind: 'plugin', plugin: 'dsh-tavern', worldbookSnapshot: snapshot } }, { surfaceOp: 'append' })
  assert.equal(worldbookSnapshot(back, '晴'), null)
})
test('任意 EJS 都进入动态区域，包括配置读取和无状态表达式', () => {
  const placement = worldbookPlacement([
    { ref: 'fixed', constant: true, content: '固定背景' },
    { ref: 'config', constant: true, content: '<%= getvar("weather") %>' },
    { ref: 'computed', constant: true, content: '<%= 1 + 1 %>' }
  ])
  assert.deepEqual([...placement.prefixRefs], ['fixed'])
  assert.deepEqual([...placement.foregroundRefs].sort(), ['computed', 'config'])
})

import { clearFailedTurnSurface, clearRegenerationAttemptSurface } from '../tavern-plugin/lib/domain/rollback-surface.js'
test('失败轮清理后重试会重新发送，已成功的旧快照仍可复用', () => {
  const session = Session.create('snapshot-failure')
  append(session, '晴')
  appendSessionEvent(session, 'turn/start', { turn: 2 })
  append(session, '雨')
  appendSessionEvent(session, 'turn/end', { turn: 2, reason: { kind: 'error', message: 'fixture' } })
  assert.ok(clearFailedTurnSurface({ session, turn: 2 }))
  assert.equal(worldbookSnapshot(session, '晴'), null)
  assert.ok(worldbookSnapshot(session, '雨'))
})

import { createInitializationNative } from './fixtures/conversation-initialization-native.mjs'
test('真实 Agent 请求中，同值省略、新值只追加且保留此前完整请求前缀', { skip: !process.env.DSH_BOOT_MODULE }, async t => {
  const h = await createInitializationNative(process.env.DSH_BOOT_MODULE)
  t.after(() => h.dispose())
  let text = '天气：晴', n = 0
  const adapter = createForegroundFrameSessionAdapter()
  h.ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    const frame = createForegroundFrameBuilder().build({ chatId: 'chat', branchId: 'branch', basedOnRevision: n, operationId: 'op-' + (++n), turn: payload.turn,
      inputs: [{ kind: 'foreground.user-input', sourceText: '继续' }, { kind: 'foreground.active-worldbook', text }] })
    return { ...decision, messages: adapter.append({ session: payload.agent.session, messages: decision.messages, frame, step: payload.step }).messages }
  })
  for (const value of ['天气：晴', '天气：晴', '天气：雨']) {
    text = value
    h.target.agent.followup({ id: crypto.randomUUID(), role: 'user', content: [{ type: 'text', text: '继续' }], source: { kind: 'human' } })
    await h.target.agent.whenIdle()
  }
  assert.equal(h.requests.length, 3)
  const visible = request => request.messages.map(({ role, content }) => ({ role, content }))
  for (let i = 1; i < 3; i++) {
    const before = visible(h.requests[i - 1])
    assert.deepEqual(visible(h.requests[i]).slice(0, before.length), before)
  }
  const snapshots = request => request.messages.filter(message => message.source?.worldbookSnapshot)
  assert.equal(snapshots(h.requests[0]).length, 1)
  assert.equal(snapshots(h.requests[1]).length, 1)
  assert.equal(snapshots(h.requests[2]).length, 2)
})

test('放弃重生成时清理临时快照，恢复原版本', () => {
  const session = Session.create('snapshot-regeneration')
  append(session, '晴')
  const eventStart = session.seq
  append(session, '雨')
  assert.ok(clearRegenerationAttemptSurface({ session, eventStart }))
  assert.equal(worldbookSnapshot(session, '晴'), null)
  assert.ok(worldbookSnapshot(session, '雨'))
})

import { createSceneImageNativeRuntime } from './fixtures/scene-image-native-runtime.mjs'
test('真实后台任务跨请求及重启复用快照，变化和清空均追加', { skip: !process.env.DSH_BOOT_MODULE }, async t => {
  let current = '骰子：17'
  const h = await createSceneImageNativeRuntime(process.env.DSH_BOOT_MODULE, { residentOptions: {
    resolveCurrentWorldbook: async () => ({ prefixContext: '固定背景', foregroundContext: current })
  } })
  t.after(() => h.dispose())
  let persistentSessionId
  for (const value of ['骰子：17', '骰子：17', '骰子：8', '']) {
    current = value
    const result = await h.runBackground({ sessionId: 'scene-parent', task: 'candidate', persistent: true, persistentSessionId,
      selection: { provider: 'scene-fixture', model: 'fixture-text' }, messages: [], tools: [] })
    persistentSessionId = result.traceSessionId
    if (h.requests.length === 1) await h.restart()
  }
  const latest = h.requests.map(request => request.messages.filter(message => message.source?.worldbookSnapshot).at(-1))
  assert.equal(latest[0].source.worldbookSnapshot.text, '骰子：17')
  assert.equal(latest[1].id, latest[0].id)
  assert.equal(latest[2].source.worldbookSnapshot.text, '骰子：8')
  assert.equal(latest[3].source.worldbookSnapshot.text, '')
})
