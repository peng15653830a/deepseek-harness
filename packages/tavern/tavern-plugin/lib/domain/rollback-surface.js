import { isRescuedHistoryMessage } from './chat-history-rescue.js'
import { replaceSessionSurface } from './session-surface-mutations.js'
import { restoredSurfaceSeqs } from './surface-restoration.js'
import { sessionEvents, appendSessionEvent, surfaceReplacementRange } from './session-events.js'
import { randomUUID } from 'node:crypto'

function object(value) {
  return value !== null && typeof value === 'object' ? value : null
}

function eventAt(events, seq) {
  const direct = events[seq]
  if (direct && Number(direct.seq) === Number(seq)) return direct
  return events.find(event => event && Number(event.seq) === Number(seq)) || null
}

function modelSourceOf(event) {
  const data = object(event && event.data)
  const message = object(data && data.message)
  const source = object(message && message.source)
  return source && source.kind === 'model' ? source : null
}

function isForegroundContext(event) {
  const source = event?.type === 'user/message' && event.data?.source
  return source?.kind === 'plugin' && source.plugin === 'dsh-tavern' &&
    ['foreground-frame', 'worldbook-snapshot', 'snapshot'].includes(source.form)
}

function isRollbackUserTombstone(event) {
  const source = event && event.type === 'user/message' && event.data && event.data.source
  return source && source.kind === 'plugin' && (
    source.plugin === 'dsh-tavern-failed-turn-cleanup' ||
    source.plugin === 'dsh-tavern-regeneration-abort' ||
    source.plugin === 'dsh-tavern-context-window'
  )
}

function isRollbackAssistantTombstone(event, events) {
  if (!event || event.type !== 'assistant/message' || modelSourceOf(event) === null) return false
  const content = event.data && event.data.message && event.data.message.content
  const op = event.surfaceOp
  if (!Array.isArray(content) || content.length !== 0 || !op || op.op !== 'replace') return false
  const sources = Array.isArray(event.sourceEventSeqs) ? event.sourceEventSeqs : []
  return sources.some(function (seq) {
    const sourceEvent = eventAt(events, seq)
    return sourceEvent && sourceEvent.type === 'user/message'
  })
}

function modelTurns(events, seqs) {
  const turns = new Set()
  for (const seq of seqs) {
    const event = eventAt(events, seq)
    const turn = Number(event && event.data && event.data.turn)
    if (event && event.type === 'assistant/message' && modelSourceOf(event) !== null && Number.isSafeInteger(turn) && turn > 0) turns.add(turn)
  }
  return [...turns].sort(function (left, right) { return left - right })
}

export function regenerationAttemptTurns(input) {
  const events = Array.isArray(input && input.events) ? input.events : []
  const eventStart = Math.max(0, Number(input && input.eventStart) || 0)
  return modelTurns(events, events.filter(function (event) {
    return event && Number.isSafeInteger(event.seq) && event.seq >= eventStart
  }).map(function (event) { return event.seq }))
}

export function abortedRegenerationTurns(input) {
  const events = Array.isArray(input && input.events) ? input.events : []
  const seqs = []
  for (const event of events) {
    const source = event && event.type === 'user/message' && event.data && event.data.source
    if (!source || source.kind !== 'plugin' || source.plugin !== 'dsh-tavern-regeneration-abort') continue
    if (Array.isArray(event.sourceEventSeqs)) seqs.push(...event.sourceEventSeqs)
  }
  return modelTurns(events, seqs)
}

// The native rollback may consume a failed-turn cleanup tombstone rather than
// its original streamed assistant node. Follow that provenance to hide the
// interrupted turn too; stopping alone must retain its visible error/partial reply.
export function rolledBackSurfaceTurns(events) {
  const restored = restoredSurfaceSeqs(events)
  const bySeq = new Map(events.filter(event => Number.isSafeInteger(event?.seq)).map(event => [event.seq, event]))
  const turns = new Set()
  const visited = new Set()
  function visit(seq) {
    if (visited.has(seq)) return
    visited.add(seq)
    const event = bySeq.get(seq)
    if (!event) return
    const turn = Number(event.data?.turn)
    if (event.type === 'assistant/message' && modelSourceOf(event) !== null && Number.isSafeInteger(turn) && turn > 0) turns.add(turn)
    if (event.surfaceOp?.op === 'replace') for (const source of event.sourceEventSeqs || []) visit(source)
  }
  for (const event of events) {
    if (restored.has(event.seq) || !isRollbackAssistantTombstone(event, events)) continue
    for (const seq of event.sourceEventSeqs || []) visit(seq)
  }
  return [...turns].sort((left, right) => left - right)
}

export function foregroundSuppressedTurns(chat, events) {
  return Array.from(new Set((Array.isArray(chat?.suppressedDshTurns) ? chat.suppressedDshTurns : [])
    .concat(abortedRegenerationTurns({ events }), rolledBackSurfaceTurns(events))
    .map(Number).filter(turn => Number.isSafeInteger(turn) && turn > 0))).sort((left, right) => left - right)
}

// Legacy regeneration left a durable empty replacement at the saved story turn.
// Surface replacement hides messages, not DSH's turn/end error nodes. Derive
// their display suppression without changing the immutable event history.
export function supersededRegenerationErrorTurns(input) {
  const events = Array.isArray(input && input.events) ? input.events : []
  const syntheticTurns = new Set((Array.isArray(input && input.suppressedDshTurns) ? input.suppressedDshTurns : []).map(Number))
  if (syntheticTurns.size === 0) return []
  const bySeq = new Map()
  const endings = new Map()
  const failures = []
  const hidden = new Set()
  for (const event of events) {
    if (!event || !Number.isSafeInteger(event.seq)) continue
    bySeq.set(event.seq, event)
    if (event.type === 'turn/end') {
      endings.set(Number(event.data.turn), event)
      if (event.data.reason && event.data.reason.kind === 'error') failures.push(event)
    }
    const op = event.surfaceOp
    if (event.type !== 'assistant/message' || modelSourceOf(event) === null || !op || op.op !== 'replace') continue
    const content = event.data.message.content
    if (!Array.isArray(content) || content.length !== 0) continue
    const body = bySeq.get(surfaceReplacementRange(op).end)
    const turn = Number(body && body.data && body.data.turn)
    const end = endings.get(turn)
    if (!body || body.type !== 'assistant/message' || modelSourceOf(body) === null || !syntheticTurns.has(turn) || turn === Number(event.data.turn)) continue
    if (!end || end.seq <= body.seq || end.seq >= event.seq || end.data.reason.kind !== 'completed') continue
    if (!Array.isArray(body.data.message.content) || !body.data.message.content.some(block => block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '')) continue
    for (const failure of failures) {
      if (failure.seq >= surfaceReplacementRange(op).start && failure.seq <= surfaceReplacementRange(op).end) hidden.add(Number(failure.data.turn))
    }
  }
  return [...hidden].sort((a, b) => a - b)
}

export function locateRegenerationSurface(input) {
  const events = Array.isArray(input && input.events) ? input.events : []
  const nodes = Array.isArray(input && input.nodes) ? input.nodes : []
  const turn = Number(input && input.turn)
  if (!Number.isSafeInteger(turn) || turn < 1) return null
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const event = eventAt(events, nodes[index])
    if (!event || event.type !== 'assistant/message' || Number(event.data && event.data.turn) !== turn) continue
    const source = modelSourceOf(event)
    if (source === null) continue
    // Current swipes leave a non-empty replacement; legacy swipes can be empty.
    // Plugin cleanup markers and messages from other turns are not the saved story body.
    return Object.freeze({ assistantSeq: Number(nodes[index]), turn, source })
  }
  return null
}

// Failed turns have already left the model surface, but remain visible until
// the user explicitly clears them. Never consume a committed story to do that.
export function pendingFailedSurfaceTurns({ events = [], nodes = [], suppressed = [] }) {
  const hidden = new Set(suppressed.map(Number))
  const turns = new Set()
  for (let index = nodes.length - 1; index >= 0; index--) {
    const event = eventAt(events, nodes[index])
    // A later successful turn may already have been rolled back. Its empty
    // marker and legacy context snapshots do not end the pending failure tail.
    if (isRollbackAssistantTombstone(event, events) || isForegroundContext(event)) continue
    if (!isRollbackUserTombstone(event)) break
    if (event.data.source.plugin !== 'dsh-tavern-failed-turn-cleanup') continue
    const sources = event.sourceEventSeqs || []
    const failed = new Set(modelTurns(events, sources))
    // A provider can fail before emitting any assistant message. Recover the
    // turn from the cleaned nodes' enclosing lifecycle, including old records.
    let started = null
    for (const candidate of events) {
      if (candidate?.type === 'turn/start') started = candidate
      if (candidate?.type !== 'turn/end' || !started) continue
      if (Number(candidate.data?.turn) === Number(started.data?.turn) &&
          ['error', 'aborted'].includes(candidate.data?.reason?.kind) &&
          sources.some(seq => seq > started.seq && seq < candidate.seq)) {
        failed.add(Number(candidate.data.turn))
      }
      started = null
    }
    for (const turn of failed) {
      if (Number.isSafeInteger(turn) && turn > 0 && !hidden.has(turn)) turns.add(turn)
    }
  }
  return [...turns].sort((a, b) => a - b)
}

export function locateRollbackSurface(input) {
  const events = Array.isArray(input && input.events) ? input.events : []
  const nodes = Array.isArray(input && input.nodes) ? input.nodes : []
  let userIndex = -1
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const event = eventAt(events, nodes[index])
    if (event?.type === 'user/message' && event.data?.source?.kind === 'plugin' && ['compact', 'dsh-compaction-basic'].includes(event.data.source.plugin)) return null
    if (event && event.type === 'user/message' && !isForegroundContext(event) && !isRollbackUserTombstone(event)) {
      userIndex = index
      break
    }
  }
  if (userIndex < 0) return null

  let assistantIndex = -1
  let assistantEvent = null
  let source = null
  for (let index = nodes.length - 1; index > userIndex; index -= 1) {
    const event = eventAt(events, nodes[index])
    const candidateSource = event && event.type === 'assistant/message' ? modelSourceOf(event) : null
    // A previous rollback leaves an empty, model-sourced replacement because
    // native DSH restore rejects plugin-owned assistant messages. It is a
    // projection tombstone, not the assistant reply paired with this user.
    if (candidateSource !== null && !isRollbackAssistantTombstone(event, events)) {
      assistantIndex = index
      assistantEvent = event
      source = candidateSource
      break
    }
  }
  if (assistantIndex < 0 || assistantEvent === null || source === null) return null

  const shadowedSeqs = nodes.slice(userIndex)
  return Object.freeze({
    userSeq: Number(nodes[userIndex]),
    assistantSeq: Number(nodes[assistantIndex]),
    endSeq: Number(shadowedSeqs[shadowedSeqs.length - 1]),
    turn: Math.max(0, Number(assistantEvent.data && assistantEvent.data.turn) || 0),
    step: Math.max(1, Number(assistantEvent.data && assistantEvent.data.step) || 1),
    source,
    shadowedSeqs: Object.freeze(shadowedSeqs.slice())
  })
}

export function planRegenerationSurface(input) {
  const events = Array.isArray(input && input.events) ? input.events : []
  const nodes = Array.isArray(input && input.nodes) ? input.nodes : []
  const oldAssistantSeq = Number(input && input.oldAssistantSeq)
  const eventStart = Math.max(0, Number(input && input.eventStart) || 0)
  const oldAssistantIndex = nodes.indexOf(oldAssistantSeq)
  if (oldAssistantIndex < 0) throw new Error('旧正文已经不在当前模型消息面中')

  let finalAssistantIndex = -1
  for (let index = nodes.length - 1; index > oldAssistantIndex; index -= 1) {
    const seq = Number(nodes[index])
    if (seq < eventStart) continue
    const event = eventAt(events, seq)
    if (event && event.type === 'assistant/message' && modelSourceOf(event) !== null) {
      finalAssistantIndex = index
      break
    }
  }
  if (finalAssistantIndex < 0) throw new Error('重新生成流程未在当前模型消息面中产生正文')

  const shadowedSeqs = nodes.slice(oldAssistantIndex, finalAssistantIndex + 1).map(Number)
  if (shadowedSeqs.length === 0) throw new Error('重新生成流程没有需要替换的旧消息')
  return Object.freeze({
    start: shadowedSeqs[0],
    end: shadowedSeqs[shadowedSeqs.length - 1],
    finalAssistantSeq: Number(nodes[finalAssistantIndex]),
    shadowedSeqs: Object.freeze(shadowedSeqs)
  })
}

export function planFailedTurnSurface(input) {
  const events = Array.isArray(input && input.events) ? input.events : []
  const nodes = Array.isArray(input && input.nodes) ? input.nodes : []
  const turn = Math.max(0, Number(input && input.turn) || 0)
  let startSeq = -1
  let endSeq = -1
  for (const event of events) {
    if (!event || !Number.isSafeInteger(event.seq) || Number(event.data && event.data.turn) !== turn) continue
    if (event.type === 'turn/start') startSeq = Math.max(startSeq, event.seq)
    if (event.type === 'turn/end') endSeq = Math.max(endSeq, event.seq)
  }
  if (startSeq < 0 || endSeq <= startSeq) return null

  // Retiring an older frame writes a new event at its historical surface
  // position. That empty replacement belongs to the old context, not this
  // failed attempt; including it would span a previously committed reply.
  function isRetiredHistoricalFrame(seq) {
    const event = eventAt(events, seq)
    if (!isForegroundContext(event) || event.data.source.form !== 'foreground-frame' ||
      !Array.isArray(event.data.content) || event.data.content.length !== 0 || event.surfaceOp?.op !== 'replace') return false
    const range = surfaceReplacementRange(event.surfaceOp)
    return Number.isSafeInteger(range.start) && Number.isSafeInteger(range.end) &&
      range.start < startSeq && range.end < startSeq
  }

  let firstIndex = -1
  let lastIndex = -1
  for (let index = 0; index < nodes.length; index += 1) {
    const seq = Number(nodes[index])
    if (seq <= startSeq || seq >= endSeq) continue
    if (isRetiredHistoricalFrame(seq)) continue
    if (firstIndex < 0) firstIndex = index
    lastIndex = index
  }
  if (firstIndex < 0 || lastIndex < firstIndex) return null

  const shadowedSeqs = nodes.slice(firstIndex, lastIndex + 1).map(Number)
  const outsideTurn = shadowedSeqs.find(function (seq) { return seq <= startSeq || seq >= endSeq })
  if (outsideTurn !== undefined) throw new Error('失败回合的模型消息面不是连续区间，无法安全清理: ' + outsideTurn)
  return Object.freeze({
    start: shadowedSeqs[0],
    end: shadowedSeqs[shadowedSeqs.length - 1],
    shadowedSeqs: Object.freeze(shadowedSeqs)
  })
}

export function clearFailedTurnSurface(input) {
  const session = input && input.session
  if (!session || typeof session.append !== 'function') return 0
  const cleanup = planFailedTurnSurface({
    events: sessionEvents(session),
    nodes: session.surface && session.surface.nodes,
    turn: input.turn
  })
  if (cleanup === null) return 0
  const makeId = typeof input.id === 'function' ? input.id : function () { return randomUUID() }
  // DSH permits plugin-injected user messages, but assistant messages must be
  // model-sourced on restore. Keep this empty tombstone explicitly plugin-owned.
  replaceSessionSurface(session, 'user/message', {
    id: makeId(),
    role: 'user',
    content: [],
    source: { kind: 'plugin', plugin: 'dsh-tavern-failed-turn-cleanup' }
  }, { start: cleanup.start, end: cleanup.end, sourceEventSeqs: cleanup.shadowedSeqs })
  return cleanup.shadowedSeqs.length
}

/** Remove only the temporary DSH surface nodes appended by a regeneration attempt. */
export function clearRegenerationAttemptSurface(input) {
  const session = input && input.session
  if (!session || typeof session.append !== 'function') return 0
  const nodes = session.surface && Array.isArray(session.surface.nodes) ? session.surface.nodes : []
  const eventStart = Math.max(0, Number(input && input.eventStart) || 0)
  const events = sessionEvents(session)
  // A replacement has a new seq but keeps its historical position. Ownership
  // follows displaced nodes; event time alone cannot identify temporary input.
  const end = events.find(event => event.seq >= eventStart && (event.type === 'turn/end' ||
    (event.type === 'user/message' && event.data?.source?.kind === 'user')))?.seq ?? Infinity
  const owned = new Set()
  for (const event of events) {
    if (event.seq < eventStart) continue
    if (event.surfaceOp?.op === 'replace') {
      const refs = event.sourceEventSeqs
      if (Array.isArray(refs) && refs.length > 0 && refs.every(seq => owned.has(seq))) owned.add(event.seq)
    } else if (event.seq < end && event.surfaceOp === 'append') {
      owned.add(event.seq)
    }
  }
  const temporary = nodes.filter(seq => owned.has(Number(seq))).map(Number)
  if (temporary.length === 0) return 0
  const firstIndex = nodes.indexOf(temporary[0])
  const lastIndex = nodes.indexOf(temporary[temporary.length - 1])
  if (firstIndex < 0 || lastIndex < firstIndex || lastIndex - firstIndex + 1 !== temporary.length) {
    throw new Error('重新生成临时消息不是连续区间，无法安全清理')
  }
  const makeId = typeof input.id === 'function' ? input.id : function () { return randomUUID() }
  replaceSessionSurface(session, 'user/message', {
    id: makeId(),
    role: 'user',
    content: [],
    source: { kind: 'plugin', plugin: 'dsh-tavern-regeneration-abort' }
  }, { start: temporary[0], end: temporary[temporary.length - 1], sourceEventSeqs: temporary })
  return temporary.length
}

export function hasRollbackMessages(messages) {
  const list = Array.isArray(messages) ? messages : []
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = object(list[index])
    if (!message || message.role !== 'assistant' || message.greeting === true) continue
    const user = object(list[index - 1])
    return user !== null && user.role === 'user'
  }
  return false
}

// Recover only ended, uncommitted failures still present at the surface tail.
// A missing cleanup hook must not turn an interrupted input into a dead end.
function unclearedFailedTail(chat, events, nodes) {
  const tail = nodes.findLast(seq => {
    const event = eventAt(events, seq)
    return !isRollbackAssistantTombstone(event, events) && !isRollbackUserTombstone(event) && !isForegroundContext(event)
  })
  if (tail === undefined) return []
  const latest = (chat.messages || []).findLast(message => message?.role === 'assistant')
  const lastEvent = eventAt(events, tail)
  if (lastEvent?.type === 'assistant/message' && (Number(lastEvent.data?.turn) === Number(latest?.turn) || Number(lastEvent.data?.turn) === Number(chat.regeneratedDshTurns?.[String(latest?.turn)]))) return []
  const committed = new Set((chat.messages || []).filter(message => message?.role === 'assistant').map(message => Number(message.turn)))
  for (const turn of Object.values(chat.regeneratedDshTurns || {})) committed.add(Number(turn))
  const starts = new Map(), intervals = []
  for (const event of events) {
    const turn = Number(event.data?.turn)
    if (event.type === 'turn/start') starts.set(turn, event.seq)
    if (event.type === 'turn/end' && starts.has(turn)) {
      intervals.push({ turn, start: starts.get(turn), end: event.seq, failed: ['error', 'aborted'].includes(event.data?.reason?.kind) })
      starts.delete(turn)
    }
  }
  let remaining = [...nodes]
  const result = []
  while (remaining.length) {
    const event = eventAt(events, remaining.at(-1))
    if (isRollbackAssistantTombstone(event, events) || isRollbackUserTombstone(event) || isForegroundContext(event)) { remaining.pop(); continue }
    const interval = intervals.findLast(item => event && event.seq > item.start && event.seq < item.end)
    if (!interval?.failed || committed.has(interval.turn)) break
    const plan = planFailedTurnSurface({ events, nodes: remaining, turn: interval.turn })
    if (!plan) break
    result.push(interval.turn)
    const removed = new Set(plan.shadowedSeqs)
    remaining = remaining.filter(seq => !removed.has(seq))
  }
  return result
}

// UI and mutation share the same native target and failed-tail precedence.
export function rollbackAvailability(chat, { events = [], nodes = [] } = {}) {
  const unclearedTurns = unclearedFailedTail(chat, events, nodes)
  const failedTurns = [...new Set([...pendingFailedSurfaceTurns({ events, nodes, suppressed: chat.suppressedDshTurns || [] }), ...unclearedTurns])].sort((a, b) => a - b)
  if (failedTurns.length) return { canRollback: true, canClearIncompleteReply: true, failedTurns, unclearedTurns, target: null, reason: '' }
  const target = locateRollbackSurface({ events, nodes })
  const messages = Array.isArray(chat.messages) ? chat.messages : []
  const latest = messages.findLast(message => message?.role === 'assistant' && message.greeting !== true)
  if (isRescuedHistoryMessage(chat, latest)) return { canRollback: false, canClearIncompleteReply: false, failedTurns, target: null, reason: '存档救援导入的历史不可回退，请发送新消息继续' }
  const turn = Number(latest?.turn)
  const matches = target && (!(turn > 0) || target.turn === turn || target.turn === Number(chat.regeneratedDshTurns?.[String(turn)]))
  const hasMessages = hasRollbackMessages(messages)
  const canRollback = hasMessages && Boolean(matches)
  return { canRollback, canClearIncompleteReply: false, failedTurns, target: canRollback ? target : null,
    reason: canRollback ? '' : hasMessages ? '当前轮次已不在可回退的消息流中，请继续发送新消息；历史正文仍保留。' : '当前没有可回退的已提交轮次' }
}
