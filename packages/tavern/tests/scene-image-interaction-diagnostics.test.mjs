import test from 'node:test'
import assert from 'node:assert/strict'
import { createSceneImageDiagnostics, recordSceneImageInteraction } from '../tavern-plugin/lib/domain/scene-image-diagnostics.js'

test('生图前置日志只保存固定字段，与生成详情隔离且导出可读', async () => {
  const documents = new Map()
  const diagnostics = createSceneImageDiagnostics({
    updateJson: async (path, fn) => {
      const document = await fn(structuredClone(documents.get(path)))
      documents.set(path, structuredClone(document))
      return document
    },
    readJson: async path => structuredClone(documents.get(path))
  })
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
