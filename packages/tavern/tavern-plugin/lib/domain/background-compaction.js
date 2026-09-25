// Background maintenance runs inside the owning Agent turn, never through the
// idle Tavern compaction queue (which would wait for this same task to finish).
export async function compactBackgroundIfNeeded({ trigger, forced, native, pressure }) {
  // Native policy owns its threshold, pruning, retained tail and retries. Extra
  // task budgeting must never veto that check, even when metadata is unavailable.
  if (trigger === 'context-overflow') return forced()
  const result = await native()
  if (result) return result
  const budget = await pressure()
  if (!budget || budget.inputTokens + budget.outputTokens < budget.capacity) return null
  return forced()
}

// Use the current task's route and output limit, not the last task's model.
// The meter includes durable system/tools/history; pending messages have not
// entered that surface yet. Provider-confirmed overflow remains the fallback
// for estimation error and models without capacity metadata.
export async function measureBackgroundBudget({ agent, background, signal, llm, meter, pending = [] }) {
  const selection = background.selection
  let info
  try { info = await llm.resolveModelInfo(selection.provider, selection.model, signal) }
  catch (error) {
    if (signal?.aborted) throw error
    return null
  }
  const capacity = info?.context?.contextWindow
  if (!Number.isFinite(capacity) || capacity <= 0) return null
  const previous = agent.session.requestHeader()
  const envelope = previous ? { ...previous, config: { ...previous.config, ...selection } } : undefined
  return {
    inputTokens: meter.measure(agent.session, envelope).totalTokens + pending.reduce((sum, message) => sum + meter.estimateMessage(message), 0),
    outputTokens: background.maxTokens ?? info.defaultMaxTokens ?? 0,
    capacity
  }
}
