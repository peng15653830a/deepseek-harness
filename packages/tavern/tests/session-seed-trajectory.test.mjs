import assert from 'node:assert/strict'
import test from 'node:test'

import { Session } from './fixtures/dsh-session-host.mjs'
import { ensureSessionSeedTrajectory, sessionSeedTrajectoryMessages } from '../tavern-plugin/lib/domain/session-seed-trajectory.js'
import { sessionEvents } from '../tavern-plugin/lib/domain/session-events.js'

test('固定会话种子以 user assistant user 轨迹进入原生 Session', async () => {
  const session = Session.create('seed-test')
  const result = await ensureSessionSeedTrajectory(session)

  assert.deepEqual(session.deriveMessages().map(message => message.role), ['user', 'assistant', 'user'])
  assert.deepEqual(session.deriveMessages().map(message => message.content[0].text), sessionSeedTrajectoryMessages(session.id).map(message => message.text))
  assert.deepEqual(result.events.map(event => event.seq), [0, 1, 2])
  assert.deepEqual(session.deriveMessages().map(message => message.source), [
    { kind: 'plugin', plugin: 'dsh-tavern', form: 'synthetic-trajectory', version: 1 },
    { kind: 'model', provider: 'dsh-tavern', model: 'synthetic-trajectory', version: 1 },
    { kind: 'plugin', plugin: 'dsh-tavern', form: 'synthetic-trajectory', version: 1 }
  ])
})

test('会话种子重建后保持幂等，不重复追加轨迹', async () => {
  let session = Session.create('seed-rebuild')
  await ensureSessionSeedTrajectory(session)
  const before = sessionEvents(session)
  session = Session.create(session.id, before, session.header)

  const result = await ensureSessionSeedTrajectory(session)

  assert.deepEqual(sessionEvents(session).filter(event => event.type !== 'session/end-seed'), before)
  assert.deepEqual(result.events.map(event => event.seq), [0, 1, 2])
})

test('会话种子可从自身尾部的部分写入继续，不覆盖或重复已有事件', async () => {
  const session = Session.create('seed-partial')
  const messages = sessionSeedTrajectoryMessages(session.id)
  session.append('user/message', messages[0].data, { surfaceOp: 'append' })
  const before = structuredClone(sessionEvents(session))

  await ensureSessionSeedTrajectory(session)

  assert.deepEqual(sessionEvents(session).slice(0, before.length), before)
  assert.deepEqual(session.deriveMessages().map(message => message.role), ['user', 'assistant', 'user'])
})

test('部分会话种子之后出现其他消息时拒绝穿插补写', async () => {
  const session = Session.create('seed-interleaved')
  const messages = sessionSeedTrajectoryMessages(session.id)
  session.append('user/message', messages[0].data, { surfaceOp: 'append' })
  session.append('user/message', {
    id: 'other', role: 'user', content: [{ type: 'text', text: '其他消息' }], source: { kind: 'user' }
  }, { surfaceOp: 'append' })
  const before = structuredClone(sessionEvents(session))

  await assert.rejects(ensureSessionSeedTrajectory(session), /种子轨迹不完整且已被其他操作推进/)
  assert.deepEqual(sessionEvents(session), before)
})
