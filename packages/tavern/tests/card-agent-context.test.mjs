import { sessionEvents } from '../tavern-plugin/lib/domain/session-events.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { createNativePlayOrchestrationStrategy } from '../tavern-plugin/lib/domain/foreground-orchestration-strategies.js'
import { ensureSessionSeedTrajectory, sessionSeedTrajectoryMessages } from '../tavern-plugin/lib/domain/session-seed-trajectory.js'
import { Session } from './fixtures/dsh-session-host.mjs'
import { ensureCardWorkspaceMessage } from '../tavern-plugin/lib/domain/card-workspace-message.js'
import { ensureSessionStablePrefix, sessionStablePrefixSections } from '../tavern-plugin/lib/domain/session-stable-prefix.js'

test('工作区说明作为种子之后的 user 快照持久化，恢复和分叉不重复注入', async () => {
  let session = Session.create('workspace-injection')
  await ensureSessionSeedTrajectory(session, 'story')
  ensureCardWorkspaceMessage(session, '【工作区】原始路径')
  session = Session.create('forked-workspace', sessionEvents(session), Session.create('forked-workspace').header)
  ensureCardWorkspaceMessage(session, '不重复添加')
  const messages = session.deriveMessages()
  assert.deepEqual(messages.map(m => m.role), ['user', 'assistant', 'user', 'user'])
  assert.equal(messages.at(-1).content[0].text, '【工作区】原始路径')
  assert.equal(messages.at(-1).source.form, 'snapshot')
})

test('实验编辑原样使用前台固定 system，工作区说明不混入 system', async () => {
  const text = '【故事设定 · 人物卡】\n人物设定\n\n【常驻世界书】\n世界设定'
  let session = Session.create('card-edit-experiment')
  await ensureSessionStablePrefix(session, text)
  await ensureSessionSeedTrajectory(session, 'story')
  session = Session.create(session.id, session.events, session.header)
  await ensureSessionStablePrefix(session, '不应替换快照')
  const strategy = createNativePlayOrchestrationStrategy({
    modeFor: async () => 'card', visibleTools: async () => [], cardSystemPrompt: () => '卡片专用指令',
    workspaceContext: () => '工作区说明', controlledToolNames: new Set()
  })
  const fixedSystemSections = sessionStablePrefixSections(session)
  const assembly = await strategy.assembleSystemPrompt({ sections: [], tools: [] }, {
    sessionId: session.id, chat: { cardEditContext: { version: 1 } }, fixedSystemSections
  })
  assert.deepEqual(assembly.sections, fixedSystemSections)
  assert.doesNotMatch(session.deriveMessages().flatMap(m => m.content).map(b => b.text || '').join('\n'), /世界设定/)
})

test('卡片种子使用原生轨迹，部分写入恢复和重载不会重复', async () => {
  let session = Session.create('card-seed')
  const first = sessionSeedTrajectoryMessages(session.id, 'card')[0]
  session.append(first.type, first.data, first.intent)
  await ensureSessionSeedTrajectory(session, 'card')
  session = Session.create(session.id, session.events, session.header)
  await ensureSessionSeedTrajectory(session, 'card')
  const messages = session.deriveMessages()
  assert.deepEqual(messages.map(m => m.role), ['user', 'assistant', 'user'])
  assert.match(messages[0].content[0].text, /待编辑素材/)
  assert.doesNotMatch(messages.map(m => m.content[0].text).join('\n'), /只输出小说正文|从人物卡给定的开场继续/)
})

test('卡片 system 只读取自定义文本，空白清空且不恢复旧注入', async () => {
  let text = ''
  const strategy = createNativePlayOrchestrationStrategy({
    modeFor: async () => 'card', visibleTools: async () => [],
    cardSystemPrompt: () => text,
    modePrompt: () => { throw Error('旧规则不应读取') },
    cardContext: () => { throw Error('人物卡不应读取') },
    workspaceContext: () => '工作区说明',
    controlledToolNames: new Set()
  })
  const assemble = () => strategy.assembleSystemPrompt({ sections: [{ name: 'old', text: 'inherited' }], tools: [] }, { sessionId: 'card' })
  assert.deepEqual((await assemble()).sections, [{ name: 'tavern:resource-workspace', text: '工作区说明' }])
  text = '自定义指令'
  assert.deepEqual((await assemble()).sections, [{ name: 'tavern:card-system', text }, { name: 'tavern:resource-workspace', text: '工作区说明' }])
  text = '  \n '
  assert.deepEqual((await assemble()).sections, [{ name: 'tavern:resource-workspace', text: '工作区说明' }])
})
