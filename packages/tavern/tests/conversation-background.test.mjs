import assert from 'node:assert/strict'
import test from 'node:test'
import { adoptConversationBackground, patchConversationBackground } from '../tavern-plugin/lib/domain/conversation-background.js'
import { resolveChatBackgroundModel } from '../tavern-plugin/lib/domain/background-model-selection.js'

test('旧存档一次性保存原生效配置，两个对话修改互不影响', () => {
  const legacy = { backgroundModel: { provider: 'p', model: 'global' }, backgroundModelRevision: 2, backgroundTasks: { variables: false, posture: true, characterDesign: true } }
  const a = adoptConversationBackground({ id: 'a', backgroundModelSelection: { provider: 'p', model: 'old' } }, legacy)
  const b = adoptConversationBackground({ id: 'b' }, legacy)
  assert.equal(a.backgroundModelSelection.model, 'global')
  assert.equal(a.backgroundTasks.variables, false)
  legacy.backgroundModel.model = 'changed'
  assert.equal(adoptConversationBackground(a, legacy), a)
  const changed = patchConversationBackground(a, { backgroundModel: null, backgroundTasks: { posture: false, ledger: true } })
  assert.equal(changed.backgroundModelSelection, null)
  assert.equal(changed.backgroundTasks.posture, false)
  assert.equal(changed.backgroundTasks.ledger, false)
  assert.equal(b.backgroundTasks.posture, true)
  assert.equal(b.backgroundModelSelection.model, 'global')
  assert.deepEqual(resolveChatBackgroundModel(changed, { provider: 'front', model: 'this-game' }), { provider: 'front', model: 'this-game' })
  assert.equal(a.backgroundTasks.characterDesign, false, '旧自动人物设计开关不再启用后台任务')
  assert.equal(changed.backgroundTasks.characterDesign, false)
})

test('搜索和生图只保存到本局，旧全局开关只迁移一次', async () => {
  const { adoptConversationFeatures } = await import('../tavern-plugin/lib/domain/conversation-background.js')
  const first = adoptConversationFeatures({ id: 'a' }, { webSearchEnabled: true }, true)
  const other = adoptConversationFeatures({ id: 'b' }, { webSearchEnabled: true }, true)
  const changed = patchConversationBackground(first, { webSearchEnabled: false, sceneImagesEnabled: false })
  assert.equal(changed.webSearchEnabled, false)
  assert.equal(changed.sceneImagesEnabled, false)
  assert.equal(other.webSearchEnabled, true)
  assert.equal(other.sceneImagesEnabled, true)
  assert.equal(adoptConversationFeatures(changed, { webSearchEnabled: true }, true), changed)
  assert.throws(() => patchConversationBackground(first, { sceneImagesEnabled: 'yes' }), /布尔值/)
})
