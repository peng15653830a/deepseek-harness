import assert from 'node:assert/strict'
import test from 'node:test'
import { conversationStateAtTurn, conversationForkBoundary } from '../tavern-plugin/lib/domain/conversation-fork-point.js'
import { forkConversationChat } from '../tavern-plugin/lib/domain/conversation-fork.js'

function history(count = 85) {
  const states = new Map()
  let messages = []
  for (let turn = 1; turn <= count; turn++) {
    messages.push({ role: 'user', text: 'input' + turn }, { role: 'assistant', turn, text: 'reply' + turn, variables: [{ hp: turn }] })
    states.set(turn, { id: 'chat', sessionId: 'source', mode: 'story', _storageRevision: turn, settleStatus: 'done', messages: structuredClone(messages),
      posture: 'place' + turn, scriptState: { cursor: turn }, ledger: { turn }, mvu: { enabled: true }, variables: { hp: turn },
      timeline: { checkpoints: Array.from({ length: turn - 1 }, (_, i) => ({ turn: i + 2, beforeRevision: i + 1 })).slice(-40) } })
  }
  return { source: states.get(count), states, read: async (_id, revision) => structuredClone(states.get(revision)) }
}

test('历史分叉恢复整份游戏状态，超过 40 轮仍能沿 journal 快照链查找', async () => {
  const h = history()
  const original = structuredClone(h.source)
  for (const turn of [1, 2, 40, 60, 85]) {
    const { state } = await conversationStateAtTurn(h.source, turn, h.read)
    const fork = forkConversationChat(state, { chatId: 'fork', sessionId: 'child', id: prefix => prefix + 'id' })
    assert.equal(fork.messages.length, turn * 2)
    assert.equal(fork.messages.at(-1).text, 'reply' + turn)
    assert.deepEqual(fork.variables, { hp: turn })
    assert.deepEqual(fork.messages.at(-1).variables, [{ hp: turn }])
    assert.equal(fork.scriptState.cursor, turn)
    assert.equal(fork.ledger.turn, turn)
    assert.equal(fork.posture, 'place' + turn)
  }
  assert.deepEqual(h.source, original)
})

test('分支继承的历史回合可沿来源快照继续分叉', async () => {
  const h = history(8)
  const branch = { ...structuredClone(h.source), id: 'child', _storageRevision: 1, timeline: { checkpoints: [] }, forkedFrom: { chatId: 'chat', storageRevision: 8, stateChatId: 'chat', stateRevision: 8 } }
  assert.equal((await conversationStateAtTurn(branch, 3, h.read)).state.messages.length, 6)
})

test('缺少、变化或未完成的历史状态不使用当前变量冒充', async () => {
  const h = history(3)
  await assert.rejects(conversationStateAtTurn(h.source, 999, h.read), /找不到/)
  await assert.rejects(conversationStateAtTurn(h.source, 1, async () => undefined), /不可用/)
  h.states.get(1).messages[1].text = '其他分支'
  await assert.rejects(conversationStateAtTurn(h.source, 1, h.read), /不一致/)
  h.states.get(2).settleStatus = 'running'
  await assert.rejects(conversationStateAtTurn(h.source, 2, h.read), /结算/)
})

function native() {
  const events = []
  for (const turn of [1, 2, 3]) {
    events.push({ seq: events.length, type: 'turn/start', data: { turn } })
    events.push({ seq: events.length, type: 'assistant/message', data: { turn, message: { id: 'm' + turn, source: { kind: 'model' }, content: [{ type: 'text', text: 'reply' + turn }] } } })
    events.push({ seq: events.length, type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
  }
  return { events }
}

test('原生分叉边界按所选回合确定，不把后续模型历史带入', () => {
  const session = native()
  assert.equal(conversationForkBoundary(session, {}, 1), 2)
  assert.equal(conversationForkBoundary(session, {}, 2), 5)
  assert.equal(conversationForkBoundary(session, {}, 3), 8)
  assert.throws(() => conversationForkBoundary(session, {}, 4), /边界/)
})

test('重新生成使用实际生成回合的边界，保留折叠后的正文', () => {
  const session = native()
  session.events.push({ seq: 9, type: 'assistant/message', data: { turn: 2, message: { id: 'replaced', source: { kind: 'model' }, content: [{ type: 'text', text: 'replacement' }] } } })
  assert.equal(conversationForkBoundary(session, { regeneratedDshTurns: { 2: 3 } }, 2), 8)
  assert.throws(() => conversationForkBoundary(session, {}, 2), /后续上下文/)
})

test('真实 DSH Session 种子截断后，界面与模型消息均没有未来剧情', async () => {
  const { Session } = await import('./fixtures/dsh-session-host.mjs')
  const { sessionEvents } = await import('../tavern-plugin/lib/domain/session-events.js')
  const source = Session.create('fork-source')
  for (const turn of [1, 2, 3]) {
    source.append('turn/start', { turn })
    source.append('user/message', { turn, id: 'u' + turn, role: 'user', source: { kind: 'plugin', plugin: 'fixture' }, content: [{ type: 'text', text: 'input' + turn }] }, { surfaceOp: 'append' })
    source.append('assistant/message', { turn, step: 1, stream: [], message: { id: 'a' + turn, role: 'assistant', source: { kind: 'model', model: 'fixture', provider: 'fixture' }, content: [{ type: 'text', text: 'reply' + turn }] } }, { surfaceOp: 'append' })
    source.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  const original = sessionEvents(source)
  const atSeq = conversationForkBoundary(source, {}, 2)
  const seed = original.slice(0, atSeq + 1)
  const child = Session.create('fork-child', seed)
  assert.deepEqual(child.deriveMessages().map(message => message.content[0].text), ['input1', 'reply1', 'input2', 'reply2'])
  assert.equal(child.surface.nodes.length, 4)
  assert.equal(source.deriveMessages().length, 6)
  assert.deepEqual(sessionEvents(source), original)
})
