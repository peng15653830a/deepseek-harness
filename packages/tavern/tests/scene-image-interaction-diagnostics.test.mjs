import test from 'node:test'
import assert from 'node:assert/strict'
import { createSceneImageDiagnostics, recordSceneImageInteraction } from '../tavern-plugin/lib/domain/scene-image-diagnostics.js'

test('生图前置日志只保存固定字段，与生成详情隔离且导出可读', async () => {
  let document
  const diagnostics = createSceneImageDiagnostics({ updateJson: async (_, fn) => { document = fn(document) }, readJson: async () => document })
  for (const stage of ['click', 'sent', 'received', 'failed']) {
    await recordSceneImageInteraction(diagnostics, 'chat', { requestId: 'one', turn: 2, stage, reason: 'start-error', prompt: 'PRIVATE', apiKey: 'SECRET' })
  }
  const exported = await diagnostics.read('chat')
  assert.deepEqual(exported.records[0].events.map(x => x.stage), ['click', 'sent', 'received', 'failed'])
  assert.equal(exported.records[0].event.reason, 'start-error')
  assert.doesNotMatch(JSON.stringify(exported), /PRIVATE|SECRET/)
  await diagnostics.record('chat', { requestId: 'one', targetKey: 'image', stage: 'provider', status: 'failed', details: { error: 'provider failure' } })
  assert.equal((await diagnostics.read('chat')).records.length, 2)
  await recordSceneImageInteraction(diagnostics, 'chat', { requestId: 'x', stage: 'arbitrary' })
  assert.equal((await diagnostics.read('chat')).records.length, 2)
})
