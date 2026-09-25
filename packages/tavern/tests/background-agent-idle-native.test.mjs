import assert from 'node:assert/strict'
import test from 'node:test'
import { createSceneImageNativeRuntime } from './fixtures/scene-image-native-runtime.mjs'

test('native JSONL idle release unloads Agent and Session, then restores history under the same ID', { skip: !process.env.DSH_BOOT_MODULE, timeout: 30000 }, async t => {
  let time = 0
  const runtime = await createSceneImageNativeRuntime(process.env.DSH_BOOT_MODULE, { residentOptions: { now: () => time, residentIdleMs: 1000 } })
  t.after(() => runtime.dispose())
  const run = text => runtime.runBackground({ sessionId: 'scene-parent', task: 'candidate', persistent: true,
    selection: { provider: 'scene-fixture', model: 'fixture-text' },
    messages: [{ role: 'user', content: [{ type: 'text', text }] }], tools: [] })
  const first = await run('历史标记：空闲释放之前')
  assert.deepEqual(runtime.backgroundLoaded(first.traceSessionId), { agent: true, session: true })
  time = 1000
  await runtime.reapBackground()
  assert.deepEqual(runtime.backgroundLoaded(first.traceSessionId), { agent: false, session: false })
  const second = await run('恢复后的新任务')
  assert.equal(second.traceSessionId, first.traceSessionId)
  assert.match(JSON.stringify(runtime.requests.at(-1).messages), /历史标记：空闲释放之前/)
  assert.match(JSON.stringify(runtime.requests.at(-1).messages), /恢复后的新任务/)
})
