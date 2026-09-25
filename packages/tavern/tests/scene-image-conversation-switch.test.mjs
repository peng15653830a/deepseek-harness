import test from 'node:test'
import assert from 'node:assert/strict'
import { createSceneImageNativeRuntime } from './fixtures/scene-image-native-runtime.mjs'

test('本局生图开关独立于全局 API 配置，关闭仍可读已有图片', { skip: !process.env.DSH_BOOT_MODULE, timeout: 30000 }, async t => {
  const runtime = await createSceneImageNativeRuntime(process.env.DSH_BOOT_MODULE)
  t.after(() => runtime.dispose())
  await runtime.service.configure({ enabled: false })
  runtime.chat.sceneImagesEnabled = true
  const target = await runtime.service.status('scene-parent', 1)
  assert.equal(target.enabled, true)
  await runtime.service.start('scene-parent', 1, target.key)
  let result
  for (let i = 0; i < 200; i++) {
    result = await runtime.service.status('scene-parent', 1)
    if (result.status === 'succeeded' || result.status === 'failed') break
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.equal(result.status, 'succeeded')
  runtime.chat.sceneImagesEnabled = false
  const disabled = await runtime.service.status('scene-parent', 1)
  assert.equal(disabled.enabled, false)
  assert.deepEqual(disabled.versions, result.versions)
  const count = runtime.imageRequests.length
  await assert.rejects(runtime.service.start('scene-parent', 1, target.key), /本局设置/)
  assert.equal(runtime.imageRequests.length, count)
  assert.equal((await runtime.service.settings()).enabled, false)
})
