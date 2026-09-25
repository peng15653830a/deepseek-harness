import assert from 'node:assert/strict'
import test from 'node:test'
import { prompt } from '../tavern-plugin/lib/prompt-catalog.js'
import { applyTavernSettingsPatch, resolveSystemPrompt } from '../tavern-plugin/lib/domain/tavern-settings.js'
import { createBackgroundAgentRunner } from '../tavern-plugin/lib/background-agent-runner.js'

test('附加指令保存、清空和导入均可立即读取', () => {
  let settings = applyTavernSettingsPatch({}, { systemPrompt: { name: 'system-append', text: '附加内容' } })
  assert.equal(resolveSystemPrompt(settings, 'system-append', prompt), '附加内容')
  settings = applyTavernSettingsPatch(settings, { systemPrompt: { name: 'system-append', text: '' } })
  assert.equal(resolveSystemPrompt(settings, 'system-append', prompt), '')
  assert.doesNotThrow(() => applyTavernSettingsPatch(settings, { systemPrompts: { 'system-append': '' } }))
})

for (const task of ['settlement', 'image', 'phone']) test(task + ' 复用会话时置顶最新指令且清空后移除', async () => {
  let assemble, completeSection, pending, text = '第一版'
  const seen = []
  const session = { id: task, header: {}, events: [], append(type, data) { this.events.push({ type, data }) } }
  const runner = createBackgroundAgentRunner({
    systemAppend: () => text,
    agents: { get: () => ({ session: { header: {} } }), async create(options) {
      await options.setup({ systemPrompt: { section(section) { if (section.complete) completeSection = section }, suppressRuntimeContext() {} }, tools: { restrict() {}, register() {} }, on(event, callback) { if (event === 'system-prompt/assemble') assemble = callback } })
      return { agent: { session, followup() { pending = (async () => {
        const result = await assemble({}, { agent: { session } }, async () => ({ sections: [{ name: 'original', text: '原有指令' }], tools: [] }))
        // Match the host: complete sections are snapshotted before the hook
        // and replace its sections afterwards.
        const completeText = completeSection.text()
        seen.push({ hook: result.sections.map(s => s.text), system: completeText })
        session.append('assistant/message', { message: { content: [{ type: 'text', text: '完成' }] } })
      })() }, async whenIdle() { await pending } }, async dispose() {} }
    } }
  })
  try {
    for (text of ['第一版', '第二版', '']) await runner.run({ sessionId: 'parent', persistent: true, task, selection: { provider: 'test', model: 'fake' }, messages: [], tools: [] })
    assert.deepEqual(seen.map(result => result.hook), [['第一版', '原有指令'], ['第二版', '原有指令'], ['原有指令']])
    assert.ok(seen[0].system.startsWith('第一版\n\n'))
    assert.ok(seen[1].system.startsWith('第二版\n\n'))
    assert.equal(seen[2].system.includes('第一版'), false)
    assert.equal(seen[2].system.includes('第二版'), false)
  } finally { await runner.dispose() }
})


test('真实 DSH complete system 在后台各任务中保留最新附加指令', { skip: !process.env.DSH_BOOT_MODULE }, async t => {
  const { createSceneImageNativeRuntime } = await import('./fixtures/scene-image-native-runtime.mjs')
  let text = '附加指令第一版'
  const runtime = await createSceneImageNativeRuntime(process.env.DSH_BOOT_MODULE, { systemAppend: () => text })
  t.after(() => runtime.dispose())
  for (const task of ['settlement', 'candidate', 'image', 'phone']) {
    for (text of ['附加指令第一版', '附加指令第二版', '']) {
      const start = runtime.requests.length
      await runtime.runBackground({ sessionId: 'scene-parent', persistent: true, task, selection: { provider: 'scene-fixture', model: 'fixture-text' }, messages: [], tools: [] })
      const requests = runtime.requests.slice(start)
      assert.ok(requests.length > 0)
      for (const request of requests) {
        if (text) assert.ok(request.system.startsWith(text + '\n\n'), task + ': ' + request.system.slice(0, 60))
        else assert.equal(request.system.includes('附加指令'), false)
      }
    }
  }
})


test('附加指令默认关闭，开关只影响运行内容且保留用户覆盖', async () => {
  const { readFileSync } = await import('node:fs')
  const { presentTavernSettings } = await import('../tavern-plugin/lib/domain/tavern-settings.js')
  const source = readFileSync(new URL('../tavern-plugin/lib/index.js', import.meta.url), 'utf8')
  const implementation = source.slice(source.indexOf('  function runtimePrompt(name)'), source.indexOf('  function presentSystemPrompts'))
  const resolve = document => new Function('tavernSettingsDocument', 'resolveSystemPrompt', 'prompt', implementation + '; return runtimePrompt;')(document, resolveSystemPrompt, name => name === 'system-append' ? '默认内容' : '其他提示词')
  let document = applyTavernSettingsPatch({}, { systemPrompt: { name: 'system-append', text: '用户内容' } })
  assert.equal(presentTavernSettings(document, {}).systemAppendEnabled, false)
  assert.equal(resolve(document)('system-append'), '')
  assert.equal(resolve({})('system-append'), '')
  document = applyTavernSettingsPatch(document, { systemAppendEnabled: true })
  assert.equal(resolve(document)('system-append'), '用户内容')
  document = applyTavernSettingsPatch(document, { systemAppendEnabled: false })
  assert.equal(resolve(document)('system-append'), '')
  assert.equal(document.promptOverrides['system-append'], '用户内容')
  assert.equal(resolve(document)('story'), '其他提示词')
  document = applyTavernSettingsPatch(document, { systemAppendEnabled: true, systemPrompt: { name: 'system-append', text: null } })
  assert.equal(resolve(document)('system-append'), '默认内容')
})
