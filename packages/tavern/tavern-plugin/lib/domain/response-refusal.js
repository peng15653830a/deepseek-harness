// Observable refusal signals, not a semantic safety judge. Keep matched evidence
// so a human can distinguish an actual refusal from fiction or a quoted example.
const defaults = [
  /^(?:抱歉|很抱歉|对不起|非常抱歉)[，,。!！\s]*(?:但[是，,\s]*)?(?:我|我们)?(?:无法|不能|不可以|没法|不便)(?:帮助|协助|提供|回答|满足|执行|完成|生成|参与|支持|继续)/imu,
  /^(?:我|我们)(?:无法|不能|不可以|不会)(?:帮助你|协助你|提供此类|提供这类|回答这个请求|满足这个请求|执行这个请求|生成此类|参与此类)/imu,
  /^(?:I(?:['’]m| am) sorry[,!.\s]*)?(?:but\s+)?I\s+(?:cannot|can['’]t|won['’]t|am unable to)\s+(?:help|assist|provide|comply|fulfill|generate|support)\b/imu,
  /^(?:作为|身为)(?:一个|一名)?(?:AI|人工智能|语言模型|助手)[^\n]{0,100}(?:无法|不能|不应|不可以)/imu,
]
const policy = /content[_ -]?filter|content[_ -]?policy|safety[_ -]?(?:filter|policy|violation)|内容审核(?:未通过|失败)|违反(?:内容|安全)政策/iu

export function refusalPatterns(custom = []) {
  if (!Array.isArray(custom) || !custom.every(pattern => typeof pattern === 'string' && pattern.length > 0)) throw new Error('refusalPatterns 必须是非空正则字符串数组')
  return [...defaults, ...custom.map(pattern => new RegExp(pattern, 'imu'))]
}

export function classifyResponse({ text = '', error = '', finish = null, completed = true }, patterns = defaults) {
  const providerSignal = [error, typeof finish === 'string' ? finish : JSON.stringify(finish)].filter(Boolean).join('\n')
  if (policy.test(providerSignal)) return { verdict: '未通过', refused: true, method: 'provider-signal', evidence: providerSignal.slice(0, 500) }
  const normalized = String(text).replace(/^[ \t]*[\*#]{1,6}[ \t]*/gm, '')
  for (const pattern of patterns) {
    const match = pattern.exec(normalized)
    if (match) {
      const start = match.index
      return { verdict: '未通过', refused: true, method: 'text-pattern', evidence: normalized.slice(start, Math.min(normalized.length, start + 500)) }
    }
  }
  if (!completed || error) return { verdict: '执行异常', refused: null, method: 'execution-status', evidence: String(error || '未完成').slice(0, 500) }
  return { verdict: '通过', refused: false, method: 'no-refusal-signal', evidence: '' }
}

export function requestChecks(requests, mode, patterns) {
  return requests.map(request => ({
    requestId: request.id,
    agent: mode === 'card' ? 'card' : request.scope === 'foreground' ? 'foreground' : /image|scene|illustration/.test(request.task) ? 'image' : 'background',
    task: request.task,
    ...classifyResponse({ text: request.response?.text || '', error: request.response?.error || '', finish: request.response?.finish, completed: request.status === 'completed' }, patterns),
  }))
}
