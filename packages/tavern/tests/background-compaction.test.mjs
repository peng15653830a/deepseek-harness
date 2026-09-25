import test from 'node:test'
import assert from 'node:assert/strict'
import { compactBackgroundIfNeeded, measureBackgroundBudget } from '../tavern-plugin/lib/domain/background-compaction.js'

function harness(pressure) {
  const calls = []
  return { calls, options: {
    pressure: async () => pressure,
    native: async () => null,
    forced: async () => { calls.push('compact'); return { summary: 'shortened' } }
  } }
}
test('candidate request reserves output: 705015 + 384000 exceeds 1048576', async () => {
  const h = harness({ inputTokens: 705015, outputTokens: 384000, capacity: 1048576 })
  await compactBackgroundIfNeeded({ ...h.options, trigger: 'pressure' })
  assert.deepEqual(h.calls, ['compact'])
})
test('provider-confirmed overflow recovers even when local estimation was low or missing', async () => {
  for (const pressure of [null, { inputTokens: 10, outputTokens: 10, capacity: 1048576 }]) {
    const h = harness(pressure)
    await compactBackgroundIfNeeded({ ...h.options, trigger: 'context-overflow' })
    assert.deepEqual(h.calls, ['compact'])
  }
})
test('ordinary background work below budget keeps its history', async () => {
  for (const pressure of [null, { inputTokens: 100000, outputTokens: 384000, capacity: 1048576 }]) {
    const h = harness(pressure)
    assert.equal(await compactBackgroundIfNeeded({ ...h.options, trigger: 'pressure' }), null)
    assert.deepEqual(h.calls, [])
  }
})
test('budget uses the current model, explicit output reservation and uncommitted task messages', async () => {
  const header = { config: { provider: 'old', model: 'old' }, system: 'stable', tools: [] }
  const pending = { content: [{ type: 'text', text: 'new candidate task' }] }
  const options = {
    agent: { session: { requestHeader: () => header } },
    background: { selection: { provider: 'current', model: 'v4' }, maxTokens: 384000 },
    llm: { resolveModelInfo: async (provider, model) => {
      assert.equal(provider, 'current'); assert.equal(model, 'v4')
      return { context: { contextWindow: 1048576 }, defaultMaxTokens: 8192 }
    } },
    meter: {
      measure: (_session, envelope) => {
        assert.equal(envelope.config.model, 'v4'); assert.equal(envelope.system, 'stable')
        return { totalTokens: 700000 }
      },
      estimateMessage: message => { assert.equal(message, pending); return 5015 }
    },
    pending: [pending]
  }
  assert.deepEqual(await measureBackgroundBudget(options), { inputTokens: 705015, outputTokens: 384000, capacity: 1048576 })
  assert.equal(header.config.model, 'old')
  delete options.background.maxTokens
  assert.equal((await measureBackgroundBudget(options)).outputTokens, 8192)
  options.llm.resolveModelInfo = async () => ({})
  assert.equal(await measureBackgroundBudget(options), null)
  options.llm.resolveModelInfo = async () => { throw Error('metadata unavailable') }
  assert.equal(await measureBackgroundBudget(options), null)
  options.signal = AbortSignal.abort()
  await assert.rejects(measureBackgroundBudget(options), /metadata unavailable/)
})

test('80 percent input pressure uses native retained-tail compression before hard overflow', async () => {
  const h = harness({ inputTokens: 810, outputTokens: 10, capacity: 1000 })
  const result = await compactBackgroundIfNeeded({ ...h.options, trigger: 'pressure', native: async () => { h.calls.push('native'); return { summary: 'retained tail' } } })
  assert.deepEqual(result, { summary: 'retained tail' })
  assert.deepEqual(h.calls, ['native'])
})

test('output reservation still forces reduction when native input pressure is below threshold', async () => {
  const h = harness({ inputTokens: 700, outputTokens: 400, capacity: 1000 })
  await compactBackgroundIfNeeded({ ...h.options, trigger: 'pressure', native: async () => { h.calls.push('native'); return null } })
  assert.deepEqual(h.calls, ['native', 'compact'])
})

test('normal pressure with no native compactable range does not discard the retained tail', async () => {
  const h = harness({ inputTokens: 810, outputTokens: 10, capacity: 1000 })
  const result = await compactBackgroundIfNeeded({ ...h.options, trigger: 'pressure', native: async () => null })
  assert.equal(result, null)
  assert.deepEqual(h.calls, [])
})

for (const budget of [null, { inputTokens: 10, outputTokens: 10, capacity: 1000 }]) {
  test('native protection runs even when extra task budget is missing or low: ' + JSON.stringify(budget), async () => {
    const h = harness(budget)
    const result = await compactBackgroundIfNeeded({ ...h.options, trigger: 'pressure',
      native: async () => { h.calls.push('native'); return { summary: 'native policy' } },
      pressure: async () => { throw Error('native result must not depend on extra budgeting') }
    })
    assert.deepEqual(result, { summary: 'native policy' })
    assert.deepEqual(h.calls, ['native'])
  })
}
