import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

export function compactionPolicy(value = {}) {
  const mode = value.mode ?? 'manual'
  const rounds = value.rounds ?? 20, percent = value.percent ?? 80
  if (!['manual', 'rounds', 'percent'].includes(mode)) throw new Error('请选择有效的上下文压缩模式')
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 1000) throw new Error('自动压缩轮数须为 1–1000 的整数')
  if (!Number.isInteger(percent) || percent < 10 || percent > 95) throw new Error('自动压缩比例须为 10–95 的整数')
  return { mode, rounds, percent, revision: value.revision || 0 }
}
export function storyRoundKeys(chat) {
  return [...new Set((chat.messages || []).filter(m => m.role === 'assistant' && !m.greeting && Number.isSafeInteger(m.turn)).map(m => String(m.turn)))]
}

/** Server-owned operation; persisted side receipts prevent repeating a successful side. */
export function createAutoCompaction(deps) {
  const jobs = new Map(), reserved = new Set()
  const blocked = chat => reserved.has(chat.id) || chat.contextCompaction?.operation?.status === 'running'
  async function save(id, mutate) { return deps.updateChat(id, chat => { chat.contextCompaction = mutate(chat.contextCompaction || {}); return chat }, { source: 'compaction.server' }) }
  async function run(sessionId, options = {}) {
    const chat = await deps.readChat(sessionId)
    if (!chat || !['story', 'script'].includes(chat.mode)) return null
    if (jobs.has(chat.id)) {
      const active = jobs.get(chat.id), result = await active
      if (result?.status !== 'deferred' || !options.openTurnCompact) return result
      if (jobs.get(chat.id) === active) jobs.delete(chat.id)
      return run(sessionId, options)
    }
    const job = execute(chat, options)
    jobs.set(chat.id, job)
    try { return await job } catch (error) {
      await save(chat.id, old => ({ ...old, warning: String(error.message || error).slice(0, 500) }))
      throw error
    } finally { jobs.delete(chat.id); reserved.delete(chat.id) }
  }
  async function execute(initial, options) {
    const signal = options.signal || new AbortController().signal
    let chat = initial, state = chat.contextCompaction || {}, policy = compactionPolicy(await deps.policy())
    let rounds = storyRoundKeys(chat)
    const branch = chat.timeline?.branchId || ''
    const policyKey = JSON.stringify(policy)
    if (state.operation?.status !== 'running' && (state.policyKey !== policyKey || state.sessionId !== chat.sessionId || state.branch !== branch)) {
      chat = await save(chat.id, old => ({ ...old, sessionId: chat.sessionId, branch, policyKey, baseline: rounds, operation: null, warning: '' }))
      state = chat.contextCompaction
    }
    let operation = state.operation
    const recover = operation?.status === 'running'
    if (!options.manual && !recover) {
      if (policy.mode === 'manual') return null
      // A partial/failed operation requires explicit retry. Never spin at the same threshold.
      if (['partial', 'failed'].includes(operation?.status)) return operation
      const fresh = rounds.filter(key => !(state.baseline || []).includes(key))
      if (policy.mode === 'rounds' && fresh.length < policy.rounds) return null
      if (policy.mode === 'percent') {
        const pressure = await deps.pressure(options.agent, signal, options.pendingMessages)
        if (!pressure || !Number.isFinite(pressure.percent)) {
          if (state.warning !== '无法取得当前模型上下文容量，自动压缩暂停；请配置模型窗口或改用轮数模式。') await save(chat.id, old => ({ ...old, warning: '无法取得当前模型上下文容量，自动压缩暂停；请配置模型窗口或改用轮数模式。' }))
          return null
        }
        if (pressure.percent < policy.percent) return null
        // No useful progress since the last successful compression: do not compress in a loop.
        if (!fresh.length && operation?.status === 'completed' && pressure.percent <= (operation.afterPercent ?? pressure.percent)) return null
      }
    }
    if (!recover) {
      // Wait for preceding settlement. No reservation yet: it must be allowed to finish.
      while (true) {
        signal.throwIfAborted()
        chat = await deps.readChat(initial.sessionId)
        if (!chat) return null
        const activity = deps.activity(chat)
        if (activity.role === 'settlement' && ['pending', 'running'].includes(activity.phase) && deps.settle) {
          await deps.settle(chat)
          await delay(50, undefined, { signal })
          continue
        }
        if (!activity.busy && !['pending', 'running'].includes(activity.phase)) break
        await delay(50, undefined, { signal })
      }
    }
    await deps.exclusive(chat.id, async () => {
      chat = await deps.readChat(initial.sessionId)
      const activity = deps.activity(chat)
      if (activity.busy || (!recover && activity.phase === 'pending')) throw new Error('后台任务刚开始，请稍后重试压缩')
      reserved.add(chat.id)
      if (!recover) {
        const previous = options.manual && ['partial', 'failed'].includes(state.operation?.status) ? state.operation : null
        const backgroundSessionId = chat.timeline?.participants?.background?.sessionId || ''
        operation = { id: randomUUID(), status: 'running', reason: options.manual ? 'manual' : policy.mode, startedAt: Date.now(),
          foregroundSessionId: chat.sessionId, backgroundSessionId,
          foreground: previous?.foreground?.status === 'succeeded' ? previous.foreground : { status: 'pending' },
          background: previous?.background?.status === 'succeeded' && previous.backgroundSessionId === backgroundSessionId ? previous.background : { status: backgroundSessionId ? 'pending' : 'skipped' } }
        await save(chat.id, old => ({ ...old, operation, warning: '' }))
      }
    })
    try {
      for (const side of ['foreground', 'background']) {
        const target = operation[side + 'SessionId']
        if (!target || ['succeeded', 'skipped'].includes(operation[side].status)) continue
        try {
          signal.throwIfAborted()
          if (operation[side].status === 'dispatching') {
            const evidence = await deps.recover(target, operation[side].before)
            if (evidence === 'succeeded') operation[side] = { status: 'succeeded', message: '已从原生压缩记录恢复' }
            else throw new Error('上次压缩结果未确认，请检查会话后手动重试')
          } else {
            const before = await deps.checkpoint(target)
            operation[side] = { status: 'dispatching', before }
            await save(chat.id, old => ({ ...old, operation: structuredClone(operation) }))
            if (side === 'background') await deps.markBackground(chat.id, target)
            const result = await deps.compact(target, side, options, signal)
            operation[side] = { status: 'succeeded', message: result?.message || (result ? '压缩完成' : '没有可压缩的历史') }
          }
        } catch (error) {
          // A queued player message can win the idle-maintenance race. Retry at its pre-step.
          if (side === 'foreground' && !options.manual && !options.openTurnCompact && error.code === 'busy') {
            operation.foreground = { status: 'pending' }
            operation.status = 'deferred'
            await save(chat.id, old => ({ ...old, operation: structuredClone(operation), warning: '' }))
            return operation
          }
          operation[side] = { status: 'failed', message: String(error.message || error).slice(0, 500) }
        }
        await save(chat.id, old => ({ ...old, operation: structuredClone(operation) }))
      }
      const success = side => ['succeeded', 'skipped'].includes(operation[side].status)
      operation.status = success('foreground') && success('background') ? 'completed' : operation.foreground.status === 'succeeded' || operation.background.status === 'succeeded' ? 'partial' : 'failed'
      operation.completedAt = Date.now()
      if (policy.mode === 'percent') {
        const after = await deps.pressure(options.agent, signal, options.pendingMessages)
        if (Number.isFinite(after?.percent)) operation.afterPercent = after.percent
      }
      chat = await deps.readChat(initial.sessionId)
      await save(chat.id, old => ({ ...old, operation: structuredClone(operation), ...(operation.status === 'completed' ? { baseline: storyRoundKeys(chat) } : {}), warning: operation.status === 'completed' ? (operation.afterPercent >= policy.percent ? '压缩后上下文仍较高，请检查固定背景长度或选择更大窗口的模型。' : '') : '上下文压缩未全部完成，请在更多 → 压缩上下文中重试。' }))
      return operation
    } finally { reserved.delete(chat.id) }
  }
  return { run, blocked }
}

/** Scope native automatic policy to bound Tavern sessions; other agents keep their host policy. */
export function installCompactionPolicy(engine, handler) {
  if (!engine || typeof engine.compactIfNeeded !== 'function') throw new Error('当前 DSH 缺少自动压缩策略接口，请检查宿主版本')
  const original = engine.compactIfNeeded
  async function routed(agent, trigger, signal) {
    return handler(agent, trigger, signal, () => original.call(this, agent, trigger, signal), () => original.call(this, agent, 'context-overflow', signal))
  }
  engine.compactIfNeeded = routed
  return () => { if (engine.compactIfNeeded === routed) engine.compactIfNeeded = original }
}
