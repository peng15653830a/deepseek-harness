const installations = new WeakMap()

function isTavernSurfaceEdit(session, event) {
  if (event?.type !== 'assistant/message' || event.data?.usage !== undefined) return false
  const message = event.data?.message
  const source = message?.source
  if (source?.kind !== 'model') return false
  if (source.provider === 'dsh-tavern' && source.model === 'synthetic-trajectory' &&
      message.id?.startsWith('tavern-seed-trajectory:')) return true
  if (!['tavern', 'tavern-background'].includes(session.header?.agentPreset)) return false
  const replacement = event.surfaceOp
  const refs = event.sourceEventSeqs
  if (replacement?.op !== 'replace' || !Array.isArray(refs) || refs.length === 0) return false
  // Tavern cites replaced surface messages, not provider streaming chunks.
  // Keep genuine malformed provider replies subject to the native validation.
  return refs.every(seq => Number.isSafeInteger(seq) && seq >= replacement.start && seq <= replacement.end && seq < event.seq &&
    ['user/message', 'assistant/message', 'tool/result'].includes(session.eventAt(seq).type))
}

/**
 * rc.1's meter assumes every assistant/message belongs to an active model step.
 * Tavern seeds and surface edits have no provider request/usage. Account for them
 * as injected messages in the meter's fold only, preserving their assistant role,
 * surface operation and seq. Never mutate the Session or its outgoing messages.
 * This isolated private-API shim must be covered against the installed host and
 * can be removed when upstream supports out-of-step surface edits natively.
 */
export function installTavernTokenMeter(meter) {
  if (!meter || typeof meter._foldEvent !== 'function') throw new Error('当前 DSH Token Meter 不支持 Tavern 消息统计适配，请检查 DSH 版本')
  let entry = installations.get(meter)
  if (!entry) {
    const original = meter._foldEvent
    const hadOwn = Object.hasOwn(meter, '_foldEvent')
    function fold(session, state, event) {
      const accountingEvent = isTavernSurfaceEdit(session, event)
        ? { ...event, type: 'user/message', data: event.data.message }
        : event
      return original.call(this, session, state, accountingEvent)
    }
    meter._foldEvent = fold
    entry = { original, fold, hadOwn, users: 0 }
    installations.set(meter, entry)
  }
  entry.users++
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    if (--entry.users !== 0) return
    if (entry.hadOwn) meter._foldEvent = entry.original
    else delete meter._foldEvent
    installations.delete(meter)
  }
}
