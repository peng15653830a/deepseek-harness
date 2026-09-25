// Internal metadata-only events are persisted on the Session surface but are
// not user utterances. Native compaction replays that surface independently of
// the normal request projection, so omit them at this request boundary too.
export function projectCompactionRequest(request) {
  if (request?.purpose !== 'compaction' || !Array.isArray(request.messages)) return request
  const messages = request.messages.filter(message => !(message?.role === 'user' &&
    Array.isArray(message.content) && message.content.length === 0 &&
    message.source?.kind === 'plugin' &&
    ['dsh-tavern', 'dsh-tavern-failed-turn-cleanup'].includes(message.source.plugin)))
  return messages.length === request.messages.length ? request : { ...request, messages }
}

export function installCompactionRequestProjection(ctx, ownsSession) {
  ctx.on('llm/stream', (request, next) => {
    const projected = projectCompactionRequest(request)
    if (projected === request || !request.sessionId) return next()
    return (async function * () {
      if (await ownsSession(request.sessionId)) yield * ctx.llm.stream(projected)
      else yield * next()
    })()
  })
}
