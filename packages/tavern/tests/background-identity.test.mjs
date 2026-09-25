import test from 'node:test'
import assert from 'node:assert/strict'
import { currentBackgroundSessionId, referencedBackgroundSessionIds } from '../tavern-plugin/lib/domain/background-identity.js'
test('剧情当前绑定优先，待重建不能退回遗留指针，冷索引未知不等于未使用', () => {
  const chat = { candidateAgent: { sessionId: 'old' }, timeline: { participants: { background: { sessionId: 'new' } } } }
  assert.equal(currentBackgroundSessionId(chat), 'new')
  chat.timeline.participants.background = { status: 'needs-session', sessionId: 'old' }
  assert.equal(currentBackgroundSessionId(chat), '')
  assert.equal(currentBackgroundSessionId({ candidateAgent: { sessionId: 'legacy' } }), 'legacy')
  assert.equal(currentBackgroundSessionId({ id: 'cold' }), null)
})
test('只从后台账本采集历史，不把运行中的新会话或生图任务归为历史', () => {
  const chat = { timeline: { checkpoints: [{ participants: { background: { sessionId: 'checkpoint' } } }], operations: {
    done: { kind: 'agent', role: 'candidate', status: 'completed', startedSessionId: 'done' },
    live: { kind: 'agent', role: 'settlement', status: 'running', startedSessionId: 'live' },
    image: { kind: 'agent', role: 'image', status: 'completed', startedSessionId: 'image' }
  } } }
  assert.deepEqual(referencedBackgroundSessionIds(chat), ['checkpoint', 'done'])
})
