const segment = value => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error('世界书日志标识无效')
  return value
}
export function compactRecallDiagnostics(entries = []) {
  return entries.map(({ ref, reason, stage, limit }) => ({ ref, reason, ...(stage ? { stage } : {}), ...(limit ? { limit } : {}) }))
}
const labels = { semantic: '筛选原型未保留', selected: '已选中', keywords: '关键词条件不满足', cooldown: '十轮冷却中', group: '包含组竞争未入选', budget: '超过 token 预算', limit: '旧版本条目数量上限', 'recursion-delay': '尚未到递归等级', 'recursion-excluded': '禁止递归触发', disabled: '已禁用', empty: '正文为空', 'mvu-update': '由 MVU 规则链处理' }
export function describeRecallEntries(entries) { return entries.map(entry => ({ ...entry, reasonLabel: labels[entry.reason] || entry.reason })) }

/** Independent per-operation records. Neither prompt text nor chat snapshots carry the full audit. */
export function createWorldbookRecallLog({ store, now = Date.now }) {
  const base = chatId => 'worldbook-recalls/' + segment(chatId) + '/'
  async function record({ chat, frame, log }) {
    const path = base(chat.id) + segment(frame.operationId) + '.json'
    const value = { version: 1, status: 'prepared', createdAt: now(), chatId: chat.id, sessionId: chat.sessionId,
      turn: frame.turn, operationId: frame.operationId, frameId: frame.frameId, branchId: frame.branchId, basedOnRevision: frame.basedOnRevision, ...log }
    await store.writeJson(path, value)
    await store.updateJson(base(chat.id) + 'index.json', previous => {
      const records = (previous?.records || []).filter(record => record.operationId !== frame.operationId)
      return { version: 1, records: [...records, { path, turn: frame.turn, operationId: frame.operationId, branchId: frame.branchId, createdAt: value.createdAt }] }
    })
    return path
  }
  async function read(chat, turn) {
    const index = await store.readJson(base(chat.id) + 'index.json')
    const records = index?.records || []
    const target = [...records].reverse().find(record => (!turn || record.turn === Number(turn)) && (!chat.timeline?.branchId || record.branchId === chat.timeline.branchId))
    return { log: target ? await store.readJson(target.path) : null, availableTurns: [...new Set(records.filter(record => !chat.timeline?.branchId || record.branchId === chat.timeline.branchId).map(record => record.turn))],
      message: target ? '' : '这一轮没有保存详细召回日志；旧轮次不从当前世界书反推。' }
  }
  async function requested(chat, options, requestId) {
    const messages = options.messages || []
    const frame = [...messages].reverse().find(message => message.source?.form === 'foreground-frame')
    const frameId = frame?.source?.trace?.frameId
    if (!frameId) return
    const saved = Object.values(chat.foregroundFrames || {}).find(value => value.frameId === frameId)
    const path = saved?.source?.worldBook?.recallLog
    if (!path || path !== base(chat.id) + segment(saved.operationId) + '.json') return
    const requestText = messages.flatMap(message => message.content || []).filter(part => part.type === 'text').map(part => part.text).join('\n')
    await store.updateJson(path, log => log ? { ...log, status: 'requested', requestedAt: now(), requestIds: [...new Set([...(log.requestIds || []), requestId])],
      outputs: log.outputs.map(output => ({ ...output, requestContainsText: output.location === 'foreground' ? requestText.includes(output.text) : null })) } : log)
  }
  return { record, read, requested }
}
