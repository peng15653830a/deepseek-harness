import { agentEvents } from '@deepseek-ai/dsh-agent'

export const inject = ['compaction']
const EVENT = 'tavern/resolve-compaction'

// Runs inside the preset's isolated compaction group. DSH routes this event
// through the Agent's preset ancestry, including standing/shared compositions.
export function apply(ctx) {
  ctx.on(EVENT, () => ctx.get('compaction'))
}

export async function resolveAgentCompaction(ctx, agent) {
  const engine = await agentEvents(ctx, agent).serial(EVENT, {})
  if (!engine || typeof engine.compactNow !== 'function' || typeof engine.compactIfNeeded !== 'function') {
    throw new Error('当前 Agent 未提供原生压缩能力')
  }
  return engine
}
