import assert from 'node:assert/strict'
import test from 'node:test'
import { patchConversationBackground } from '../tavern-plugin/lib/domain/conversation-background.js'
import { resolveChatBackgroundModel } from '../tavern-plugin/lib/domain/background-model-selection.js'
import { createSceneImageNativeRuntime } from './fixtures/scene-image-native-runtime.mjs'

test('原生后台 Agent 在任务边界切换模型，保留会话历史并清除旧推理强度和输出上限', { skip: !process.env.DSH_BOOT_MODULE, timeout: 30000 }, async t => {
  let selection = { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' }
  let game = patchConversationBackground({}, { backgroundModel: selection })
  let release, started
  const ready = new Promise(resolve => { started = resolve })
  const gate = new Promise(resolve => { release = resolve })
  let held = false
  const runtime = await createSceneImageNativeRuntime(process.env.DSH_BOOT_MODULE, {
    systemAppend: () => '',
    resolveModelSelection: () => resolveChatBackgroundModel(game, selection),
    beforeModelRequest: async () => { if (!held) { held = true; started(); await gate } }
  })
  t.after(() => runtime.dispose())
  t.after(() => release())
  const run = (text, tools = []) => runtime.runBackground({ sessionId: 'scene-parent', task: 'candidate', persistent: true,
    selection: { provider: 'scene-fixture', model: 'stale-caller-model' },
    messages: [{ role: 'user', content: [{ type: 'text', text }] }], tools, onToolCall: async () => JSON.stringify({ sources: [] }) })
  runtime.lookupReferences('参考资料')
  const first = run('历史标记：雨夜初遇', [{ name: 'read_scene_reference', description: 'Read fixture reference', parameters: { type: 'object', properties: { query: { type: 'string' } } } }])
  await ready
  const second = run('第二次任务')
  selection = { provider: 'scene-fixture-other', model: 'replacement' }
  game = patchConversationBackground(game, { backgroundModel: selection })
  release()
  const [a, b] = await Promise.all([first, second])
  assert.equal(a.traceSessionId, b.traceSessionId)
  assert.ok(a.traceSessionId)
  assert.deepEqual(runtime.requests.map(r => [r.model, r.reasoningEffort, r.maxTokens]), [
    ['deepseek-v4-flash', 'high', 384000], ['deepseek-v4-flash', 'high', 384000], ['replacement', undefined, undefined]
  ])
  assert.match(JSON.stringify(runtime.requests[2].messages), /历史标记：雨夜初遇/)
  selection = { provider: 'scene-fixture', model: 'third', reasoningEffort: 'low' }
  game = patchConversationBackground(game, { backgroundModel: selection })
  const c = await run('第三次任务')
  assert.equal(c.traceSessionId, a.traceSessionId)
  assert.equal(runtime.requests.at(-1).reasoningEffort, 'low')
  await runtime.restart()
  const resumed = await runtime.runBackground({ sessionId: 'scene-parent', task: 'candidate', persistent: true,
    persistentSessionId: a.traceSessionId, selection, messages: [{ role: 'user', content: [{ type: 'text', text: '重启后任务' }] }], tools: [] })
  assert.equal(resumed.traceSessionId, a.traceSessionId)
  assert.match(JSON.stringify(runtime.requests.at(-1).messages), /历史标记：雨夜初遇/)
})
