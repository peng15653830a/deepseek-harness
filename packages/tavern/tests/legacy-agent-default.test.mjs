import test from 'node:test'
import assert from 'node:assert/strict'
import { clearLegacyTavernDefault } from '../tavern-plugin/lib/domain/legacy-agent-default.js'

function fixture(user, base = 'tavern') {
  let revision = 3
  const writes = []
  const settings = {
    describe: () => [{ ns: 'agent-presets', user, base: { default: base }, revision }],
    mutate: async (ns, ops, expected) => {
      assert.equal(ns, 'agent-presets')
      assert.equal(expected, revision)
      assert.deepEqual(ops, [{ op: 'unset', path: ['default'] }])
      writes.push(ops)
      delete user.default
      revision++
    },
  }
  return { settings, writes, defaultId: () => user?.default ?? base }
}

test('clear the global Tavern override, preserving other settings and Profile default', async () => {
  const user = { default: 'tavern', other: { enabled: true } }
  const h = fixture(user)
  assert.equal(await clearLegacyTavernDefault(h.settings), true)
  assert.deepEqual(user, { other: { enabled: true } })
  assert.equal(h.defaultId(), 'tavern')
  assert.equal(fixture(user, 'standard').defaultId(), 'standard')
  assert.equal(await clearLegacyTavernDefault(h.settings), false)
  assert.equal(h.writes.length, 1)
})

for (const user of [undefined, {}, { default: 'standard' }, { default: 'custom' }]) {
  test(`preserve absent or non-Tavern user default: ${JSON.stringify(user)}`, async () => {
    const h = fixture(user)
    assert.equal(await clearLegacyTavernDefault(h.settings), false)
    assert.equal(h.writes.length, 0)
  })
}

test('do not overwrite a concurrent settings edit or conceal write failure', async () => {
  const h = fixture({ default: 'tavern' })
  h.settings.mutate = async () => { throw new Error('settings conflict') }
  await assert.rejects(clearLegacyTavernDefault(h.settings), /settings conflict/)
})
