/** Compile the explicitly ordered, text-only generateRaw contract without Session writes. */
export async function generateHelperRaw(config, { callModel, sessionId = '', history = [] }) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('generateRaw 参数必须是对象')
  const allowed = new Set(['ordered_prompts', 'user_input', 'max_chat_history', 'should_stream', 'should_silence', 'overrides'])
  for (const key of Object.keys(config)) if (!allowed.has(key)) throw new Error('generateRaw 暂不支持参数：' + key)
  if (config.should_stream === true) throw new Error('generateRaw 暂不支持流式事件，请设置 should_stream: false')
  if (!Array.isArray(config.ordered_prompts) || !config.ordered_prompts.length) throw new Error('generateRaw 需要显式 ordered_prompts')
  const overrides = config.overrides || {}
  for (const [key, value] of Object.entries(overrides)) {
    if (['world_info_before', 'world_info_after'].includes(key) && value === '') continue
    if (key === 'chat_history' && value && Object.keys(value).every(k => k === 'with_depth_entries') && value.with_depth_entries === false) continue
    throw new Error('generateRaw 暂不支持覆盖项：' + key)
  }
  const limit = config.max_chat_history ?? 'all'
  if (limit !== 'all' && (!Number.isSafeInteger(limit) || limit < 0)) throw new Error('max_chat_history 必须是非负整数或 all')
  if (config.user_input !== undefined && typeof config.user_input !== 'string') throw new Error('user_input 必须是文本')
  const messages = []
  function append(role, text) {
    if (!['system', 'user', 'assistant'].includes(role) || typeof text !== 'string') throw new Error('generateRaw 仅支持 system/user/assistant 文本消息')
    if (text.trim()) messages.push({ role, content: [{ type: 'text', text }] })
  }
  const explicitUser = config.ordered_prompts.includes('user_input')
  for (const prompt of config.ordered_prompts) {
    if (prompt === 'user_input') append('user', config.user_input || '')
    else if (prompt === 'chat_history') {
      const selected = limit === 'all' ? history : limit === 0 ? [] : history.slice(-limit)
      for (const message of selected) append(message.role, message.text)
      if (!explicitUser) append('user', config.user_input || '')
    } else if (prompt && typeof prompt === 'object' && !Array.isArray(prompt)) {
      if (Object.keys(prompt).some(k => !['role', 'content'].includes(k))) throw new Error('generateRaw 不支持此消息参数')
      append(prompt.role, prompt.content)
    } else throw new Error('generateRaw 暂不支持内置提示词：' + String(prompt))
  }
  if (!explicitUser && !config.ordered_prompts.includes('chat_history')) append('user', config.user_input || '')
  if (!messages.length) throw new Error('generateRaw 提示词不能为空')
  return await callModel({ sessionId, messages, system: '' })
}
