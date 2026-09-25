import { randomUUID } from 'node:crypto'

function str(value) {
  return typeof value === 'string' ? value : (value === undefined || value === null ? '' : String(value))
}

function phaseEntries(messages, phase) {
  const name = 'tavern:runtime-preset-' + phase
  return (Array.isArray(messages) ? messages : []).filter(function (message) {
    return Array.isArray(message && message.source && message.source.sections) && message.source.sections.some(function (section) { return section && section.name === name })
  })
}

function redactRequestMetadata(value) {
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(redactRequestMetadata)
  if (typeof value.entries === 'function' && typeof value.get === 'function') value = Object.fromEntries(value.entries())
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    /^(authorization|proxy-authorization|cookie|set-cookie|.*api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|password)$/i.test(key) ? '[REDACTED]' : redactRequestMetadata(item)]))
}

function serializableRequest(options) {
  const result = {}
  for (const [key, value] of Object.entries(options || {})) {
    if (key === 'signal') continue
    // Preserve prompt/tool evidence verbatim; redact transport/config metadata only.
    result[key] = ['messages', 'tools', 'system'].includes(key) ? value : redactRequestMetadata({ [key]: value })[key]
  }
  return JSON.parse(JSON.stringify(result))
}

// Keep the public evidence shape stable; phases are a projection of the request.
function evidenceRecord(record, result) {
  const messages = record.request && record.request.messages
  return {
    ...record,
    ...(result || {}),
    version: 1,
    phases: record.phases || {
      front: phaseEntries(messages, 'front'),
      middle: phaseEntries(messages, 'middle'),
      back: phaseEntries(messages, 'back')
    }
  }
}

export function createModelRequestLog(options = {}) {
  const readJson = options.readJson
  const writeJson = options.writeJson
  const updateJson = options.updateJson
  const now = typeof options.now === 'function' ? options.now : Date.now
  const id = typeof options.id === 'function' ? options.id : function () { return randomUUID() }
  if (typeof readJson !== 'function' || typeof writeJson !== 'function' || typeof updateJson !== 'function') throw new TypeError('模型请求日志缺少存储适配器')

  // Cache only durable ownership, never request bodies. Bound idle-session memory.
  const sessionOwners = new Map()
  const ownerWrites = new Map()
  function rememberOwner(sessionId, chatId) {
    sessionOwners.delete(sessionId)
    sessionOwners.set(sessionId, chatId)
    if (sessionOwners.size > 512) sessionOwners.delete(sessionOwners.keys().next().value)
  }
  async function ensureSessionOwner(sessionId, chatId) {
    if (!sessionId) return
    const previous = ownerWrites.get(sessionId)
    if (previous) {
      await previous.catch(() => {})
      return ensureSessionOwner(sessionId, chatId)
    }
    if (sessionOwners.get(sessionId) === chatId) return
    const pending = (async () => {
      const path = 'model-request-sessions/' + encodeURIComponent(sessionId) + '.json'
      const saved = await readJson(path)
      if (saved?.chatId !== chatId) await writeJson(path, { chatId })
      rememberOwner(sessionId, chatId)
    })()
    ownerWrites.set(sessionId, pending)
    try { await pending } finally { if (ownerWrites.get(sessionId) === pending) ownerWrites.delete(sessionId) }
  }

  async function record(input) {
    const chat = input.chat
    const context = input.context
    const coordinates = input.coordinates
    const requestOptions = input.options
    const stamp = now()
    const requestId = stamp.toString(36) + '-' + id()
    const scope = context && context.scope === 'background' ? 'background' : 'foreground'
    const turn = scope === 'background' ? Math.max(0, Number(context.turn) || 0) : Math.max(0, Number(coordinates && coordinates.turn) || 0)
    const record = {
      version: 2,
      id: requestId,
      chatId: chat.id,
      scope,
      task: scope === 'background' ? str(context.task) : 'reply',
      sessionId: str(requestOptions && requestOptions.sessionId),
      turn,
      agentTurn: Math.max(0, Number(coordinates && coordinates.turn) || 0),
      step: Math.max(1, Number(coordinates && coordinates.step) || 1),
      createdAt: stamp,
      status: 'running',
      requestMode: chat.requestMode === 'sillytavern' ? 'sillytavern' : 'dsh',
      compatibility: chat.requestMode === 'sillytavern' && chat.compatibilityTraces && chat.compatibilityTraces[String(turn)]
        ? JSON.parse(JSON.stringify(chat.compatibilityTraces[String(turn)]))
        : null,
      frame: coordinates && coordinates.frame ? JSON.parse(JSON.stringify(coordinates.frame)) : null,
      bypassPlan: {
        id: str(chat.bypassPlanId || chat.runtimePresetSnapshot && chat.runtimePresetSnapshot.planId),
        name: str(chat.runtimePresetSnapshot && chat.runtimePresetSnapshot.planName),
        digest: str(chat.runtimePresetSnapshot && chat.runtimePresetSnapshot.digest)
      },
      request: serializableRequest(requestOptions)
    }
    const base = 'model-requests/' + chat.id + '/'
    await writeJson(base + requestId + '.json', record)
    // Persist timing separately so completion after a restart never loads the body.
    await writeJson(base + requestId + '.result.json', { createdAt: stamp, status: 'running' })
    await updateJson(base + 'index.json', function (value) {
      const current = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
      const requests = Array.isArray(current.requests) ? current.requests : []
      return {
        version: 1,
        chatId: chat.id,
        requests: requests.concat([{
          id: requestId, scope, task: record.task, sessionId: record.sessionId,
          turn: record.turn, agentTurn: record.agentTurn, step: record.step,
          createdAt: record.createdAt, preset: record.preset
        }])
      }
    })
    await ensureSessionOwner(record.sessionId, chat.id)
    return evidenceRecord(record)
  }

  async function complete(input = {}) {
    const base = 'model-requests/' + str(input.chatId) + '/'
    const path = base + str(input.id) + '.json'
    const resultPath = base + str(input.id) + '.result.json'
    // Old records have no sidecar. Read them once when completing, without rewriting.
    const previous = await readJson(resultPath) || await readJson(path)
    if (!previous) return null
    const completedAt = now()
    const createdAt = Number.isFinite(previous.createdAt) ? previous.createdAt : completedAt
    const result = {
      createdAt,
      status: str(input.error) !== '' ? 'failed' : 'completed',
      completedAt,
      durationMs: Math.max(0, completedAt - createdAt),
      response: {
        text: str(input.text),
        finish: input.finish === undefined ? null : JSON.parse(JSON.stringify(input.finish)),
        error: str(input.error) || null
      }
    }
    await writeJson(resultPath, result)
    // Callers needing the full request use evidence(); completion returns only state.
    return result
  }

  async function evidence(chatId, turn) {
    const base = 'model-requests/' + chatId + '/'
    const index = await readJson(base + 'index.json')
    const entries = Array.isArray(index && index.requests) ? index.requests.filter(function (item) {
      return !Number.isSafeInteger(Number(turn)) || Number(turn) < 1 || Number(item.turn) === Number(turn)
    }) : []
    const requests = []
    for (const entry of entries) {
      const record = await readJson(base + entry.id + '.json')
      if (record) requests.push(evidenceRecord(record, await readJson(base + entry.id + '.result.json')))
    }
    return { loaded: true, chatId, requests }
  }

  async function list(chatId) {
    const index = await readJson('model-requests/' + chatId + '/index.json')
    return Array.isArray(index?.requests) ? index.requests : []
  }
  async function detail(chatId, id) {
    const entries = await list(chatId)
    if (!entries.some(entry => entry.id === id)) throw new Error('请求记录不存在')
    const base = 'model-requests/' + chatId + '/'
    const record = await readJson(base + id + '.json')
    if (!record) throw new Error('请求记录已缺失')
    return evidenceRecord(record, await readJson(base + id + '.result.json'))
  }
  async function latest(chatId, knownId, sessionId) {
    const entries = await list(chatId)
    const entry = entries.findLast(item => sessionId ? item.sessionId === sessionId : item.scope === 'foreground')
    if (!entry) return null
    if (knownId === entry.id) return { unchanged: true, id: entry.id }
    const base = 'model-requests/' + chatId + '/'
    const record = await readJson(base + entry.id + '.json')
    return record ? evidenceRecord(record, await readJson(base + entry.id + '.result.json')) : null
  }
  async function latestForSession(sessionId, knownId, fallbackChatId) {
    if (!sessionId) return null;
    const owner = await readJson('model-request-sessions/' + encodeURIComponent(sessionId) + '.json');
    const chatId = owner?.chatId || fallbackChatId;
    return chatId ? latest(chatId, knownId, sessionId) : null;
  }
  return Object.freeze({ record, complete, evidence, list, detail, latest, latestForSession })
}
