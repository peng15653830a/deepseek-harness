function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

export function normalizeBackgroundModel(value) {
  if (value === null || value === undefined) return null
  const input = object(value)
  const provider = text(input.provider)
  const model = text(input.model)
  if (provider === '' || model === '') return null
  return { provider, model }
}

export function snapshotBackgroundModel(configured) {
  // Null means resolve the current foreground selection when each task starts.
  // Only an explicit user choice is frozen into the game.
  return normalizeBackgroundModel(configured)
}

export function resolveChatBackgroundModel(chat, fallback) {
  const source = object(chat).backgroundModelSelection || fallback
  const selected = normalizeBackgroundModel(source)
  if (selected !== null && typeof source?.reasoningEffort === 'string' && source.reasoningEffort.trim() !== '') {
    selected.reasoningEffort = source.reasoningEffort.trim()
  }
  return selected
}
