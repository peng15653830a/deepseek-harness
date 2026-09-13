import test from 'node:test'
import assert from 'node:assert/strict'
import { generateHelperRaw } from '../tavern-plugin/lib/domain/helper-generation.js'

test('人物卡原样 generateRaw 参数独立生成，不隐式注入历史或修改输入', async () => {
  const config = { ordered_prompts: [{ role: 'user', content: '生成测试档案' }], max_chat_history: 25, should_stream: false,
    overrides: { world_info_before: '', world_info_after: '', chat_history: { with_depth_entries: false } } }
  const before = structuredClone(config)
  let request
  const result = await generateHelperRaw(config, { sessionId: 's1', history: [{ role: 'assistant', text: '不要发送的正文' }], callModel: async r => { request = r; return '---\nname: test' } })
  assert.equal(result, '---\nname: test')
  assert.deepEqual(request, { sessionId: 's1', system: '', messages: [{ role: 'user', content: [{ type: 'text', text: '生成测试档案' }] }] })
  assert.deepEqual(config, before)
})
test('显式历史按位置与条数展开，错误向调用者传播', async () => {
  let request
  await generateHelperRaw({ ordered_prompts: [{ role: 'system', content: '规则' }, 'chat_history'], max_chat_history: 1, user_input: '问题' }, {
    history: [{ role: 'user', text: '旧' }, { role: 'assistant', text: '新' }], callModel: async r => { request = r; return 'ok' } })
  assert.deepEqual(request.messages.map(m => m.content[0].text), ['规则', '新', '问题'])
  await assert.rejects(generateHelperRaw({ ordered_prompts: [{ role: 'user', content: 'x' }] }, { callModel: async () => { throw Error('模型失败') } }), /模型失败/)
})
test('不支持的能力明确失败，不发送模型请求', async () => {
  for (const extra of [{ should_stream: true }, { tools: [] }, { custom_api: {} }, { overrides: { char_description: 'x' } }]) {
    await assert.rejects(generateHelperRaw({ ordered_prompts: [{ role: 'user', content: 'x' }], ...extra }, { callModel: () => assert.fail('不应请求') }), /暂不支持/)
  }
})
