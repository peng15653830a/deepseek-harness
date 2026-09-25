import assert from 'node:assert/strict'
import test from 'node:test'

import { rollbackAvailability, pendingFailedSurfaceTurns, abortedRegenerationTurns, clearFailedTurnSurface, hasRollbackMessages, locateRollbackSurface, planFailedTurnSurface, planRegenerationSurface, regenerationAttemptTurns } from '../tavern-plugin/lib/domain/rollback-surface.js'

function modelSource() {
  return { kind: 'model', provider: 'test', model: 'test-model' }
}

test('回退识别正则替换后的可见助手节点，并同时覆盖本轮用户输入与输出', () => {
  const events = []
  events[2] = {
    seq: 2,
    type: 'assistant/message',
    data: { turn: 1, step: 1, message: { role: 'assistant', source: modelSource() } },
    surfaceOp: 'append'
  }
  events[5] = {
    seq: 5,
    type: 'user/message',
    data: { role: 'user', content: [{ type: 'text', text: '本轮输入' }] },
    surfaceOp: 'append'
  }
  events[8] = {
    seq: 8,
    type: 'assistant/message',
    data: { turn: 2, step: 1, message: { role: 'assistant', source: modelSource() } },
    surfaceOp: 'append'
  }
  events[9] = {
    seq: 9,
    type: 'assistant/message',
    data: { turn: 2, step: 1, message: { role: 'assistant', source: modelSource() } },
    surfaceOp: { op: 'replace', start: 8, end: 8 },
    sourceEventSeqs: [8]
  }

  const located = locateRollbackSurface({ events, nodes: [2, 5, 9] })

  assert.equal(located.userSeq, 5)
  assert.equal(located.assistantSeq, 9)
  assert.equal(located.turn, 2)
  assert.deepEqual(located.shadowedSeqs, [5, 9])
  assert.equal(located.source.kind, 'model')
})

test('只有开场白而没有用户输入时不存在可回退轮次', () => {
  const events = []
  events[2] = {
    seq: 2,
    type: 'assistant/message',
    data: { turn: 1, step: 1, message: { role: 'assistant', source: modelSource() } },
    surfaceOp: 'append'
  }

  assert.equal(locateRollbackSurface({ events, nodes: [2] }), null)
})

test('重生成失败清理墓碑不冒充最后用户输入，仍可回退原轮次', () => {
  const events = []
  events[15] = {
    seq: 15,
    type: 'user/message',
    data: { role: 'user', content: [{ type: 'text', text: '本轮输入' }], source: { kind: 'user' } },
    surfaceOp: 'append'
  }
  events[555] = {
    seq: 555,
    type: 'assistant/message',
    data: { turn: 2, step: 1, message: { role: 'assistant', source: modelSource() } },
    surfaceOp: 'append'
  }
  events[753] = {
    seq: 753,
    type: 'user/message',
    data: { role: 'user', content: [], source: { kind: 'plugin', plugin: 'dsh-tavern-regeneration-abort' } },
    surfaceOp: { op: 'replace', start: 562, end: 750 },
    sourceEventSeqs: [562, 563, 750]
  }

  const located = locateRollbackSurface({ events, nodes: [15, 555, 753] })

  assert.equal(located.userSeq, 15)
  assert.equal(located.assistantSeq, 555)
  assert.equal(located.turn, 2)
  assert.deepEqual(located.shadowedSeqs, [15, 555, 753])
})

test('连续回退时跳过上一轮回退留下的助手墓碑，继续定位更早一轮', () => {
  const events = []
  events[2] = {
    seq: 2,
    type: 'assistant/message',
    data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '开场白' }], source: modelSource() } },
    surfaceOp: 'append'
  }
  events[5] = {
    seq: 5,
    type: 'user/message',
    data: { role: 'user', content: [{ type: 'text', text: '第一轮输入' }], source: { kind: 'user' } },
    surfaceOp: 'append'
  }
  events[8] = {
    seq: 8,
    type: 'assistant/message',
    data: { turn: 2, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '第一轮正文' }], source: modelSource() } },
    surfaceOp: 'append'
  }
  events[10] = {
    seq: 10,
    type: 'user/message',
    data: { role: 'user', content: [{ type: 'text', text: '第二轮输入' }], source: { kind: 'user' } },
    surfaceOp: 'append'
  }
  events[12] = {
    seq: 12,
    type: 'assistant/message',
    data: { turn: 3, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '第二轮正文' }], source: modelSource() } },
    surfaceOp: 'append'
  }
  events[20] = {
    seq: 20,
    type: 'assistant/message',
    data: { turn: 3, step: 1, message: { role: 'assistant', content: [], source: modelSource() } },
    surfaceOp: { op: 'replace', start: 10, end: 12 },
    sourceEventSeqs: [10, 12]
  }

  const located = locateRollbackSurface({ events, nodes: [2, 5, 8, 20] })

  assert.equal(located.userSeq, 5)
  assert.equal(located.assistantSeq, 8)
  assert.equal(located.turn, 2)
  assert.deepEqual(located.shadowedSeqs, [5, 8, 20])
})

test('失败重生成的模型轮次可从尝试区间和持久清理墓碑重建', () => {
  const events = []
  events[20] = { seq: 20, type: 'user/message', data: { source: { kind: 'plugin', plugin: 'dsh-tavern-regen' } } }
  events[21] = {
    seq: 21,
    type: 'assistant/message',
    data: { turn: 3, message: { source: modelSource(), content: [{ type: 'text', text: '临时正文' }] } }
  }
  events[22] = {
    seq: 22,
    type: 'user/message',
    data: { source: { kind: 'plugin', plugin: 'dsh-tavern-regeneration-abort' }, content: [] },
    surfaceOp: { op: 'replace', start: 20, end: 21 },
    sourceEventSeqs: [20, 21]
  }

  assert.deepEqual(regenerationAttemptTurns({ events, eventStart: 20 }), [3])
  assert.deepEqual(abortedRegenerationTurns({ events }), [3])
})

test('回退按钮只在权威消息尾部存在用户输入与正文组合时显示', () => {
  const opening = { role: 'assistant', greeting: true, text: '开场白' }
  const user = { role: 'user', text: '本轮输入' }
  const assistant = { role: 'assistant', text: '本轮输出' }

  assert.equal(hasRollbackMessages([opening]), false)
  assert.equal(hasRollbackMessages([opening, user]), false)
  assert.equal(hasRollbackMessages([opening, user, assistant]), true)
})

test('重新生成正文完整遮蔽旧正文、失败回合残留和合成输入', () => {
  const events = []
  events[48] = {
    seq: 48,
    type: 'assistant/message',
    data: { turn: 2, step: 1, message: { role: 'assistant', source: modelSource() } },
    surfaceOp: 'append'
  }
  events[55] = { seq: 55, type: 'user/message', data: { role: 'user' }, surfaceOp: 'append' }
  events[56] = { seq: 56, type: 'user/message', data: { role: 'user' }, surfaceOp: 'append' }
  events[69] = { seq: 69, type: 'user/message', data: { role: 'user' }, surfaceOp: 'append' }
  events[70] = { seq: 70, type: 'user/message', data: { role: 'user' }, surfaceOp: 'append' }
  events[99] = {
    seq: 99,
    type: 'assistant/message',
    data: { turn: 4, step: 1, message: { role: 'assistant', source: modelSource() } },
    surfaceOp: 'append'
  }

  const planned = planRegenerationSurface({
    events,
    nodes: [6, 13, 14, 48, 55, 56, 69, 70, 99],
    oldAssistantSeq: 48,
    eventStart: 65
  })

  assert.deepEqual(planned, {
    start: 48,
    end: 99,
    finalAssistantSeq: 99,
    shadowedSeqs: [48, 55, 56, 69, 70, 99]
  })
})

test('失败的正文回合从模型消息面移除本轮全部残留节点', () => {
  const events = []
  events[52] = { seq: 52, type: 'turn/start', data: { turn: 3 } }
  events[55] = { seq: 55, type: 'user/message', data: { role: 'user' }, surfaceOp: 'append' }
  events[56] = { seq: 56, type: 'user/message', data: { role: 'user' }, surfaceOp: 'append' }
  events[64] = { seq: 64, type: 'turn/end', data: { turn: 3, reason: { kind: 'error' } } }

  const planned = planFailedTurnSurface({
    events,
    nodes: [6, 13, 14, 48, 55, 56],
    turn: 3
  })

  assert.deepEqual(planned, {
    start: 55,
    end: 56,
    shadowedSeqs: [55, 56]
  })

  const calls = []
  const session = {
    events,
    surface: { nodes: [6, 13, 14, 48, 55, 56] },
    append(type, data, options) { calls.push({ type, data, options }) }
  }
  assert.equal(clearFailedTurnSurface({ session, turn: 3, id: function () { return 'cleanup-id' } }), 2)
  assert.deepEqual(calls, [{
    type: 'user/message',
    data: {
      id: 'cleanup-id',
      role: 'user',
      content: [],
      source: { kind: 'plugin', plugin: 'dsh-tavern-failed-turn-cleanup' }
    },
    options: {
      surfaceOp: { op: 'replace', start: 55, end: 56 },
      sourceEventSeqs: [55, 56]
    }
  }])
})

function failedThenRolledBack() {
  return [
    { seq: 0, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '保留输入' }] } },
    { seq: 1, type: 'assistant/message', data: { turn: 171, message: { source: modelSource(), content: [{ type: 'text', text: '保留正文' }] } } },
    { seq: 2, type: 'turn/start', data: { turn: 207 } },
    { seq: 3, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '失败输入' }] } },
    { seq: 4, type: 'turn/end', data: { turn: 207, reason: { kind: 'error' } } },
    { seq: 5, type: 'user/message', data: { source: { kind: 'plugin', plugin: 'dsh-tavern-failed-turn-cleanup' }, content: [] }, surfaceOp: { op: 'replace', start: 3, end: 3 }, sourceEventSeqs: [3] },
    { seq: 6, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '新输入' }] } },
    { seq: 7, type: 'assistant/message', data: { turn: 208, message: { source: modelSource(), content: [{ type: 'text', text: '新正文' }] } } },
    { seq: 8, type: 'assistant/message', data: { turn: 208, message: { source: modelSource(), content: [] } }, surfaceOp: { op: 'replace', start: 6, end: 7 }, sourceEventSeqs: [6, 7] },
    { seq: 9, type: 'user/message', data: { source: { kind: 'plugin', plugin: 'dsh-tavern', form: 'snapshot' }, content: [] } }
  ]
}

test('失败轮次之后的新正文被回退，仍能发现并清理被空标记挡住的失败轮次', () => {
  const events = failedThenRolledBack()
  assert.deepEqual(pendingFailedSurfaceTurns({ events, nodes: [0, 1, 5, 8, 9] }), [207])
  assert.deepEqual(pendingFailedSurfaceTurns({ events, nodes: [0, 1, 5, 8, 9], suppressed: [207] }), [])
  assert.deepEqual(pendingFailedSurfaceTurns({ events, nodes: [0, 1, 5, 6, 7] }), [], '有未回退的新正文时不清理更早失败轮次')
})

test('旧 snapshot 不冒充用户输入，清理失败轮次后仍能定位上一完整正文', () => {
  const events = failedThenRolledBack()
  const result = locateRollbackSurface({ events, nodes: [0, 1, 5, 8, 9] })
  assert.equal(result?.turn, 171)
  assert.equal(result?.userSeq, 0)
})


test('回退可用性要求聊天与原生轮次配对，允许重生成映射，不接受孤立输入', () => {
  const chat = { messages: [{ role: 'user' }, { role: 'assistant', turn: 2 }] }
  const events = [
    { seq: 0, type: 'user/message', data: { role: 'user' } },
    { seq: 1, type: 'assistant/message', data: { turn: 2, message: { source: modelSource() } } }
  ]
  assert.equal(rollbackAvailability(chat, { events, nodes: [0, 1] }).canRollback, true)
  assert.equal(rollbackAvailability(chat, { events, nodes: [0] }).canRollback, false)
  assert.equal(rollbackAvailability(chat, { events, nodes: [] }).canRollback, false)
  events[1].data.turn = 3
  assert.equal(rollbackAvailability(chat, { events, nodes: [0, 1] }).canRollback, false)
  chat.regeneratedDshTurns = { 2: 3 }
  assert.equal(rollbackAvailability(chat, { events, nodes: [0, 1] }).canRollback, true)
})

test('压缩摘要不能冒充已经压缩掉的玩家输入', () => {
  const events = [
    { seq: 0, type: 'user/message', data: { role: 'user', source: { kind: 'plugin', plugin: 'compact', compactionId: 'c' }, content: [{ type: 'text', text: '旧剧情摘要' }] } },
    { seq: 1, type: 'assistant/message', data: { turn: 2, message: { source: modelSource() } } }
  ]
  assert.equal(locateRollbackSurface({ events, nodes: [0, 1] }), null)
})

test('失败清理不消费已提交正文或仍在运行的输入', () => {
  const chat = { messages: [{ role: 'user' }, { role: 'assistant', turn: 2 }] }
  const events = [
    { seq: 0, type: 'turn/start', data: { turn: 2 } },
    { seq: 1, type: 'user/message', data: { role: 'user' } },
    { seq: 2, type: 'assistant/message', data: { turn: 2, message: { source: modelSource() } } },
    { seq: 3, type: 'turn/end', data: { turn: 2, reason: { kind: 'error' } } }
  ]
  assert.equal(rollbackAvailability(chat, { events, nodes: [1, 2] }).canClearIncompleteReply, false)
  events.push({ seq: 4, type: 'turn/start', data: { turn: 3 } }, { seq: 5, type: 'user/message', data: { role: 'user' } })
  assert.equal(rollbackAvailability(chat, { events, nodes: [1, 2, 5] }).canClearIncompleteReply, false)
})

test('摘要之前的输入不能跨越压缩点配对，摘要之后完整的新轮仍可回退', () => {
  const events = [
    { seq: 0, type: 'user/message', data: { role: 'user' } },
    { seq: 1, type: 'user/message', data: { role: 'user', source: { kind: 'plugin', plugin: 'compact' } } },
    { seq: 2, type: 'assistant/message', data: { turn: 2, message: { source: modelSource() } } }
  ]
  assert.equal(locateRollbackSurface({ events, nodes: [0, 1, 2] }), null)
  events.push({ seq: 3, type: 'user/message', data: { role: 'user' } }, { seq: 4, type: 'assistant/message', data: { turn: 3, message: { source: modelSource() } } })
  assert.deepEqual(locateRollbackSurface({ events, nodes: [1, 2, 3, 4] }).shadowedSeqs, [3, 4])
})

test('失败清理只豁免已退役的历史提示词，不放宽跨正文的安全检查', () => {
  const frame = { seq: 6, type: 'user/message', data: { content: [], source: { kind: 'plugin', plugin: 'dsh-tavern', form: 'foreground-frame' } }, surfaceOp: { op: 'replace', start: 2, end: 2 } }
  const events = [
    { seq: 3, type: 'assistant/message', data: { turn: 1 } },
    { seq: 5, type: 'turn/start', data: { turn: 2 } }, frame,
    { seq: 7, type: 'user/message', data: {} },
    { seq: 8, type: 'turn/end', data: { turn: 2, reason: { kind: 'error' } } }
  ]
  assert.equal(planFailedTurnSurface({ events, nodes: [6, 3], turn: 2 }), null)
  for (const replacement of [
    { ...frame, data: { ...frame.data, content: [{ type: 'text', text: '仍有效的提示词' }] } },
    { ...frame, data: { ...frame.data, source: { kind: 'user' } } },
    { ...frame, surfaceOp: 'append' }
  ]) {
    assert.throws(() => planFailedTurnSurface({ events: events.map(event => event === frame ? replacement : event), nodes: [6, 3, 7], turn: 2 }), /不是连续区间/)
  }
})
