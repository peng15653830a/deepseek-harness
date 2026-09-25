/** Match the host's next-request route, including defaults before the first header. */
export async function measureForegroundPressure({ agent, signal, pendingMessages = [], projections, defaultModel, llm, meter }) {
  if (!agent) return null
  const previous = agent.session.requestHeader()
  let state
  try { state = projections?.stateOf(agent.session, 'modelSelection') } catch {}
  const target = state?.pending ?? previous?.config ?? state?.lastUsed ?? defaultModel?.currentSelection()
  if (!target?.provider || !target?.model) return null
  let info
  try { info = await llm.resolveModelInfo(target.provider, target.model, signal) }
  catch (error) { if (signal?.aborted) throw error; return null }
  const capacity = info?.context?.contextWindow
  if (!Number.isFinite(capacity) || capacity <= 0) return null
  const envelope = previous ? { ...previous, config: { ...previous.config, ...target } } : undefined
  const pendingTokens = pendingMessages.reduce((sum, message) => sum + meter.estimateMessage(message), 0)
  const inputTokens = meter.measure(agent.session, envelope).totalTokens + pendingTokens
  const outputTokens = target.maxTokens ?? info.defaultMaxTokens ?? 0
  return { percent: 100 * inputTokens / capacity, budgetPercent: 100 * (inputTokens + outputTokens) / capacity }
}
