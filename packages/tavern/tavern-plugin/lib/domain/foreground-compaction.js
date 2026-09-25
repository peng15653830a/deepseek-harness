/** Native capacity protection is independent of Tavern's optional round schedule. */
export async function compactForegroundIfNeeded({ trigger, native, forced, pressure, scheduled, record }) {
  // Keep native pruning, retained-tail policy and bounded retries. In particular,
  // provider overflow must never wait for settlement or retry the background side.
  let result = await native()
  if (!result && trigger !== 'context-overflow') {
    const budget = await pressure()
    if (budget?.budgetPercent >= 100) result = await forced()
  }
  if (result) {
    await record()
    return result
  }
  if (trigger === 'context-overflow') return null
  await scheduled()
  return null
}
