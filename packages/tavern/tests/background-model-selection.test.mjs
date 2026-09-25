import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeBackgroundModel, resolveChatBackgroundModel, snapshotBackgroundModel } from '../tavern-plugin/lib/domain/background-model-selection.js'

test('后台模型设置只接受完整 provider/model', () => {
  assert.deepEqual(normalizeBackgroundModel({ provider: ' vertex ', model: ' gemini ' }), { provider: 'vertex', model: 'gemini' })
  assert.equal(normalizeBackgroundModel({ provider: 'vertex' }), null)
  assert.equal(normalizeBackgroundModel(null), null)
})

test('仅手动配置生成固定快照，默认不冻结前台模型', () => {
  assert.deepEqual(snapshotBackgroundModel({ provider: 'fixed', model: 'worker' }, { provider: 'front', model: 'chat' }), { provider: 'fixed', model: 'worker' })
  assert.equal(snapshotBackgroundModel(null, { provider: 'front', model: 'chat', reasoningEffort: 'high' }), null)
  const chat = { backgroundModelSelection: snapshotBackgroundModel(null) }
  for (const model of ['first', 'changed']) assert.deepEqual(resolveChatBackgroundModel(chat, { provider: 'front', model, reasoningEffort: 'high' }), { provider: 'front', model, reasoningEffort: 'high' })
})

test('运行时优先使用游戏快照，旧游戏才回退当前前台模型', () => {
  assert.deepEqual(resolveChatBackgroundModel({ backgroundModelSelection: { provider: 'fixed', model: 'worker', reasoningEffort: 'high' } }, { provider: 'front', model: 'chat' }), { provider: 'fixed', model: 'worker', reasoningEffort: 'high' })
  assert.deepEqual(resolveChatBackgroundModel({}, { provider: 'front', model: 'chat' }), { provider: 'front', model: 'chat' })
})

test('固定模型的推理强度保留到快照，默认档位省略且不污染前台', () => {
  const configured = { provider: 'p', model: 'm', reasoningEffort: ' custom-level ' }
  const snapshot = snapshotBackgroundModel(configured)
  configured.reasoningEffort = 'changed'
  assert.deepEqual(snapshot, { provider: 'p', model: 'm', reasoningEffort: 'custom-level' })
  assert.deepEqual(resolveChatBackgroundModel({ backgroundModelSelection: snapshot }, { provider: 'front', model: 'm', reasoningEffort: 'low' }), snapshot)
  assert.deepEqual(snapshotBackgroundModel({ provider: 'p', model: 'm', reasoningEffort: '' }), { provider: 'p', model: 'm' })
})

test('按精确模型读取宿主档位，不写死档位或在目录缺失时拒绝自定义模型', async () => {
  const { readBackgroundModelReasoning } = await import('../tavern-plugin/lib/domain/background-model-selection.js')
  const reasoning = { efforts: [{ id: 'custom-level', name: '自定义档位' }], defaultEffort: 'custom-level' }
  const calls = []
  const llm = { async resolveModelInfo(...args) { calls.push(args); return { reasoning } } }
  assert.deepEqual(await readBackgroundModelReasoning(llm, { provider: ' p ', model: 'unlisted' }), reasoning)
  assert.deepEqual(calls, [['p', 'unlisted']])
  assert.equal(await readBackgroundModelReasoning({}, { provider: 'p', model: 'm' }), null)
  assert.equal(await readBackgroundModelReasoning({ resolveModelInfo: async () => ({}) }, { provider: 'p', model: 'm' }), null)
  await assert.rejects(readBackgroundModelReasoning(llm, {}), /配置无效/)
  await assert.rejects(readBackgroundModelReasoning({ resolveModelInfo: async () => { throw Error('offline') } }, { provider: 'p', model: 'm' }), /offline/)
})

test('全局切换覆盖老游戏快照与本局选择，后续本局修改可单独生效', async () => {
  const { applyTavernSettingsPatch } = await import('../tavern-plugin/lib/domain/tavern-settings.js')
  const front = { provider: 'front', model: 'current', reasoningEffort: 'low' }
  const old = { backgroundModelSelection: { provider: 'old', model: 'frozen', reasoningEffort: 'high' } }
  let settings = applyTavernSettingsPatch({}, { backgroundModel: { provider: 'new', model: 'worker' } })
  assert.deepEqual(resolveChatBackgroundModel(old, front, settings), { provider: 'new', model: 'worker' })
  assert.deepEqual(resolveChatBackgroundModel({}, front, settings), { provider: 'new', model: 'worker' })
  const local = { backgroundModelSelection: { provider: 'local', model: 'one-game' }, backgroundModelRevision: settings.backgroundModelRevision }
  assert.deepEqual(resolveChatBackgroundModel(local, front, settings), local.backgroundModelSelection)
  settings = applyTavernSettingsPatch(settings, { backgroundModel: { provider: 'new', model: 'worker', reasoningEffort: 'max' } })
  assert.equal(resolveChatBackgroundModel(local, front, settings).reasoningEffort, 'max')
  assert.equal(resolveChatBackgroundModel(old, front, settings).reasoningEffort, 'max')
  settings = applyTavernSettingsPatch(settings, { backgroundModel: null })
  assert.deepEqual(resolveChatBackgroundModel(old, front, settings), front)
  assert.deepEqual(resolveChatBackgroundModel(local, front, settings), front)
  const revision = settings.backgroundModelRevision
  settings = applyTavernSettingsPatch(settings, { webSearchEnabled: true })
  assert.equal(settings.backgroundModelRevision, revision)
  assert.deepEqual(resolveChatBackgroundModel({ ...local, backgroundModelSelection: null, backgroundModelRevision: revision }, front, settings), front)
})
