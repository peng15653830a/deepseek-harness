import assert from 'node:assert/strict'
import test from 'node:test'
import { Session, adoptSessionEvent } from './fixtures/dsh-session-host.mjs'
import { sessionEvents, appendSessionEvent } from '../tavern-plugin/lib/domain/session-events.js'
import { rollbackAvailability, clearFailedTurnSurface, locateRegenerationSurface, locateRollbackSurface } from '../tavern-plugin/lib/domain/rollback-surface.js'

function fixture() {
  const session = Session.create('failed-turn-restore')
  const source = { kind: 'model', provider: 'test', model: 'test' }
  session.append('user/message', { id: 'user', role: 'user', content: [{ type: 'text', text: '继续' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
  appendSessionEvent(session, 'assistant/message', { turn: 1, step: 1, message: { id: 'body', role: 'assistant', content: [{ type: 'text', text: '原正文' }], source } }, { surfaceOp: 'append' })
  session.append('turn/start', { turn: 2 })
  session.append('user/message', { id: 'retry', role: 'user', content: [{ type: 'text', text: '重新生成' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
  session.append('turn/end', { turn: 2, reason: { kind: 'error' } })
  return session
}

test('失败清理经过真实 DSH 消息校验及恢复，不损坏历史或误认玩家输入', () => {
  const session = fixture()
  assert.equal(clearFailedTurnSurface({ session, turn: 2 }), 1)
  const persisted = JSON.parse(JSON.stringify(sessionEvents(session)))
  for (const event of persisted) adoptSessionEvent(event)
  const restored = Session.create(session.id, persisted, session.header)
  const input = { events: sessionEvents(restored), nodes: restored.surface.nodes }
  assert.equal(locateRegenerationSurface({ ...input, turn: 1 }).assistantSeq, 1)
  assert.equal(locateRegenerationSurface({ ...input, turn: 2 }), null)
  const rollback = locateRollbackSurface(input)
  assert.equal(rollback.userSeq, 0)
  assert.equal(rollback.assistantSeq, 1)
  assert.deepEqual(rollback.shadowedSeqs, restored.surface.nodes)
  assert.equal(sessionEvents(restored)[1].data.message.content[0].text, '原正文')
})

test('失败轮只有用户输入、从未获得模型来源，也能清理并恢复', () => {
  const session = fixture()
  clearFailedTurnSurface({ session, turn: 2 })
  const marker = sessionEvents(session).at(-1)
  assert.equal(marker.type, 'user/message')
  assert.equal(marker.data.source.kind, 'plugin')
  assert.deepEqual(marker.data.content, [])
  assert.deepEqual(marker.sourceEventSeqs, [3])
  assert.doesNotThrow(() => Session.create(session.id, sessionEvents(session), session.header))
})

test('连续回退经过真实 DSH 消息面替换与恢复，直到只剩开场白', () => {
  let session = Session.create('continuous-rollback-restore')
  const source = { kind: 'model', provider: 'test', model: 'test' }
  appendSessionEvent(session, 'assistant/message', { turn: 1, step: 1, message: { id: 'opening', role: 'assistant', content: [{ type: 'text', text: '开场白' }], source } }, { surfaceOp: 'append' })
  session.append('user/message', { id: 'user-1', role: 'user', content: [{ type: 'text', text: '第一轮' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
  appendSessionEvent(session, 'assistant/message', { turn: 2, step: 1, message: { id: 'body-1', role: 'assistant', content: [{ type: 'text', text: '第一轮正文' }], source } }, { surfaceOp: 'append' })
  session.append('user/message', { id: 'user-2', role: 'user', content: [{ type: 'text', text: '第二轮' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
  appendSessionEvent(session, 'assistant/message', { turn: 3, step: 1, message: { id: 'body-2', role: 'assistant', content: [{ type: 'text', text: '第二轮正文' }], source } }, { surfaceOp: 'append' })

  const latest = locateRollbackSurface({ events: sessionEvents(session), nodes: session.surface.nodes })
  appendSessionEvent(session, 'assistant/message', { turn: latest.turn, step: latest.step, message: { id: 'rollback-2', role: 'assistant', content: [], source: latest.source } }, {
    surfaceOp: { op: 'replace', start: latest.userSeq, end: latest.endSeq }, sourceEventSeqs: latest.shadowedSeqs
  })
  const replacementSeq = sessionEvents(session).findLast(event => event.data?.message?.id === 'rollback-2').seq
  session = Session.create(session.id, JSON.parse(JSON.stringify(sessionEvents(session))), session.header)

  const previous = locateRollbackSurface({ events: sessionEvents(session), nodes: session.surface.nodes })
  assert.equal(previous.turn, 2)
  assert.deepEqual(previous.shadowedSeqs, [1, 2, replacementSeq])
  appendSessionEvent(session, 'assistant/message', { turn: previous.turn, step: previous.step, message: { id: 'rollback-1', role: 'assistant', content: [], source: previous.source } }, {
    surfaceOp: { op: 'replace', start: previous.userSeq, end: previous.endSeq }, sourceEventSeqs: previous.shadowedSeqs
  })
  session = Session.create(session.id, JSON.parse(JSON.stringify(sessionEvents(session))), session.header)

  assert.equal(session.surface.nodes.length, 2)
  assert.equal(session.surface.nodes[0], 0)
  assert.equal(locateRollbackSurface({ events: sessionEvents(session), nodes: session.surface.nodes }), null)
})


test('真实宿主重载后可发现遗漏清理的失败输入，清理后模型不再读取它', () => {
  const original = fixture()
  const session = Session.create(original.id, JSON.parse(JSON.stringify(sessionEvents(original))), original.header)
  const chat = { messages: [{ role: 'user' }, { role: 'assistant', turn: 1 }] }
  const status = rollbackAvailability(chat, { events: sessionEvents(session), nodes: session.surface.nodes })
  assert.equal(status.canClearIncompleteReply, true)
  assert.deepEqual(status.unclearedTurns, [2])
  for (const turn of status.unclearedTurns) clearFailedTurnSurface({ session, turn })
  const restored = Session.create(session.id, JSON.parse(JSON.stringify(sessionEvents(session))), session.header)
  const visible = JSON.stringify(restored.deriveMessages())
  assert.doesNotMatch(visible, /重新生成/)
  assert.match(visible, /原正文/)
  assert.ok(sessionEvents(restored).some(event => event.data?.id === 'retry'))
})

test('新轮退役历史提示词后失败，清理及重载保留上一轮正文和退役标记', async () => {
  const { retireForegroundFrames } = await import('../tavern-plugin/lib/domain/foreground-frame-retirement.js')
  for (const traced of [true, false]) {
    let session = Session.create('retired-frame-failure')
    session.append('turn/start', { turn: 1 })
    session.append('user/message', { id: 'old-input', role: 'user', content: [{ type: 'text', text: '上一轮输入' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    session.append('user/message', { id: 'frame', role: 'user', content: [{ type: 'text', text: '旧提示词' }], source: { kind: 'plugin', plugin: 'dsh-tavern', form: 'foreground-frame', ...(traced ? { trace: { turn: 1 } } : {}) } }, { surfaceOp: 'append' })
    appendSessionEvent(session, 'assistant/message', { turn: 1, step: 1, message: { id: 'body', role: 'assistant', content: [{ type: 'text', text: '成功正文' }], source: { kind: 'model', provider: 'test', model: 'test' } } }, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    for (const turn of [2, 3]) {
      session.append('turn/start', { turn })
      retireForegroundFrames(session, { keepTurn: turn })
      session.append('user/message', { id: 'retry-' + turn, role: 'user', content: [{ type: 'text', text: '失败输入' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
      session.append('turn/end', { turn, reason: { kind: 'error' } })
      const status = rollbackAvailability({ messages: [{ role: 'user' }, { role: 'assistant', turn: 1 }] }, { events: sessionEvents(session), nodes: session.surface.nodes })
      assert.ok(status.unclearedTurns.includes(turn))
      assert.equal(clearFailedTurnSurface({ session, turn }), 1)
      assert.equal(clearFailedTurnSurface({ session, turn }), 0)
      session = Session.create(session.id, JSON.parse(JSON.stringify(sessionEvents(session))), session.header)
      assert.match(JSON.stringify(session.deriveMessages()), /成功正文/)
      assert.doesNotMatch(JSON.stringify(session.deriveMessages()), /失败输入|旧提示词/)
      assert.equal(locateRegenerationSurface({ events: sessionEvents(session), nodes: session.surface.nodes, turn: 1 }).assistantSeq, 3)
    }
  }
})
