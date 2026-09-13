import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFileResourceStore } from '../tavern-plugin/lib/domain/file-resources.js'

const server = await readFile(new URL('../tavern-plugin/lib/index.js', import.meta.url), 'utf8')
const listing = server.slice(server.indexOf('  async function listCards()'), server.indexOf('  async function resourceBindingProjection()'))

test('one non-JSON card remains visible without hiding healthy cards or modifying either file', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tavern-bad-card-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = createFileResourceStore({ dataRoot: root })
  await store.ensure()
  const bad = '<开局>\n必看\n私人正文'
  await writeFile(store.absolute('cards/损坏.json'), bad)
  await writeFile(store.absolute('cards/正常.json'), JSON.stringify({ name: '正常人物卡' }))
  const list = new Function('fileResources', 'readCardWorkspace', 'cardPreparation', 'orderCardsByNewestImport', 'return (' + listing + ')')(
    store, path => store.readCard(path), { project: value => value }, cards => cards)
  const cards = await list()
  assert.equal(cards.length, 2)
  assert.equal(cards.find(c => c.path === 'cards/正常.json').name, '正常人物卡')
  const broken = cards.find(c => c.path === 'cards/损坏.json')
  assert.match(broken.readError, /cards\/损坏.json/)
  assert.doesNotMatch(broken.readError, /私人正文|<开局>/)
  assert.equal(await store.readText(broken.path), bad)
  await writeFile(store.absolute(broken.path), JSON.stringify({ name: '修复后' }))
  const recovered = (await list()).find(c => c.path === broken.path)
  assert.equal(recovered.name, '修复后')
  assert.equal(recovered.readError, undefined)
})

const client = await readFile(new URL('../tavern-plugin/src/client/main.js', import.meta.url), 'utf8')
const sidebar = client.slice(client.indexOf('function TavernSidebar'))
const refreshSource = sidebar.slice(sidebar.indexOf('function refresh()'), sidebar.indexOf('\t\t\tReact.useEffect', sidebar.indexOf('function refresh()')))
for (const failed of ['listCards', 'listSessions']) {
  test('sidebar independently refreshes surviving data when ' + failed + ' fails', async () => {
    const state = { cards: ['previous-card'], history: ['previous-session'], errors: [] }
    const refresh = new Function('call', 'setCards', 'setHistory', 'setTrustedCardMode', 'publishSessionModes', 'current', 'isPlayMode', 'setRequestMode', 'window', 'tavernErrorHub', 'return (' + refreshSource + ')')(
      async method => {
        if (method === failed) throw new Error('unreadable file')
        return { cards: ['healthy-card'], sessions: [{ sessionId: 'current', mode: 'story' }] }
      }, value => { state.cards = value }, value => { state.history = value }, () => {}, () => {}, 'current', () => true, () => {}, {},
      { resolve() {}, report(source) { state.errors.push(source) } })
    await refresh()
    assert.deepEqual(state.cards, failed === 'listCards' ? ['previous-card'] : ['healthy-card'])
    assert.deepEqual(state.history, failed === 'listSessions' ? ['previous-session'] : [{ sessionId: 'current', mode: 'story' }])
    assert.equal(state.errors.length, 1)
  })
}
