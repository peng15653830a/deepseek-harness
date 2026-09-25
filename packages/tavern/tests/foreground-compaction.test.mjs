import test from 'node:test'
import assert from 'node:assert/strict'
import { compactForegroundIfNeeded } from '../tavern-plugin/lib/domain/foreground-compaction.js'

function fixture(overrides = {}) {
  const calls = []
  return { calls, run: (trigger = 'pressure') => compactForegroundIfNeeded({
    trigger,
    native: async () => { calls.push('native'); return { summary: 'native summary' } },
    forced: async () => { calls.push('forced'); return { summary: 'emergency summary' } },
    pressure: async () => ({ budgetPercent: 10 }),
    scheduled: async () => { calls.push('scheduled') },
    record: async () => { calls.push('record') }, ...overrides
  }) }
}
test('native pressure protection runs before the optional Tavern schedule', async () => {
  const h = fixture(); assert.deepEqual(await h.run(), { summary: 'native summary' })
  assert.deepEqual(h.calls, ['native', 'record'])
})
test('overflow never waits for the background, even when no compactable range exists', async () => {
  const h = fixture({ native: async () => null, pressure: () => { throw Error('must not measure') } })
  assert.equal(await h.run('context-overflow'), null)
  assert.deepEqual(h.calls, [])
})
test('pending input and output reservation can force recovery before the provider rejects', async () => {
  const h = fixture({ native: async () => null, pressure: async () => ({ budgetPercent: 101 }) })
  await h.run(); assert.deepEqual(h.calls, ['forced', 'record'])
})
test('round schedule still runs when native protection is not needed', async () => {
  const h = fixture({ native: async () => null })
  await h.run(); assert.deepEqual(h.calls, ['scheduled'])
})
test('native failure remains visible and does not launch joint maintenance', async () => {
  const h = fixture({ native: async () => { throw Error('summary too long') } })
  await assert.rejects(h.run(), /summary too long/); assert.deepEqual(h.calls, [])
})
