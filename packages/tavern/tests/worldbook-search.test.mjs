import test from 'node:test'
import assert from 'node:assert/strict'
import { createWorldbookSearch } from '../tavern-plugin/lib/domain/worldbook-search.js'
import { projectWorldBookTemplates } from '../tavern-plugin/lib/domain/worldbook-recall.js'

function fixture() {
  const context = { chat: { variables: { rank: '外门' }, worldBookReads: { 'entry:1': { turn: 9 } } }, card: { name: '测试' }, worldBook: { view: { entries: [
    { ref: 'entry:1', title: '门派·少林', primaryKeys: ['少林'], content: '少林入门须遵守门规。<%= rank %>' },
    { ref: 'entry:2', title: '过客经历', content: '过客曾经路过少林。' },
    { ref: 'entry:3', title: '门派·武当', content: '武当入门规矩' },
    { ref: 'entry:4', title: '少林秘密', content: '不应展示', enabled: false },
    { ref: 'entry:5', title: '[mvu_update]少林', content: '不应展示' },
    { ref: 'entry:6', title: '模板', content: '<% secretQuery() %>静态线索' }
  ] } } }
  let renders = 0
  const search = createWorldbookSearch({ load: async () => context, render: async (ctx, selectedEntries) => {
    renders++
    return projectWorldBookTemplates({ ...ctx, selectedEntries, includeConstants: true,
      runtime: { render: async (_body, { scopes }) => ({ ok: true, text: '少林入门：' + scopes.local.rank, scopes: { ...scopes, local: { rank: '已变更' } } }) } })
  } })
  return { context, search, renders: () => renders }
}
test('search finds non-injected/cooling entries, ranks title hits and returns bounded static snippets', async () => {
  const f = fixture(), result = await f.search('s', { query: '少林', limit: 1 })
  assert.equal(result.total, 2)
  assert.equal(result.hasMore, true)
  assert.equal(result.entries[0].ref, 'entry:1')
  assert.ok(result.entries[0].snippet.includes('少林'))
  assert.equal(result.entries[0].text, undefined)
  assert.equal(f.renders(), 0)
  assert.equal((await f.search('s', { query: '少林', offset: 1 })).entries[0].ref, 'entry:2')
  assert.equal((await f.search('s', { query: 'secretQuery' })).total, 0)
  assert.equal((await f.search('s', { query: '银河飞船' })).total, 0)
})
test('explicit batch read renders full current text without mutating variables or cooldown', async () => {
  const f = fixture(), before = structuredClone(f.context)
  const result = await f.search('s', { refs: ['entry:1', 'entry:3'] })
  assert.deepEqual(result.entries.map(e => e.text), ['少林入门：外门', '武当入门规矩'])
  assert.deepEqual(f.context, before)
  f.context.chat.variables.rank = '内门'
  assert.equal((await f.search('s', { refs: ['entry:1'] })).entries[0].text, '少林入门：内门')
})
test('invalid, disabled, out-of-book refs and oversized/ambiguous requests are rejected', async () => {
  const { search } = fixture()
  for (const args of [{}, { query: '少林', refs: ['entry:1'] }, { refs: [] }, { refs: ['entry:4'] }, { refs: ['entry:5'] }, { refs: ['other:1'] }, { refs: Array(6).fill('entry:1') }, { query: '少林', limit: 100 }, { query: '少林', offset: -1 }]) await assert.rejects(search('s', args))
})
test('render failures and empty templates are explicit, never replaced by raw source', async () => {
  const f = fixture()
  const search = createWorldbookSearch({ load: async () => f.context, render: async () => ({ renderedEntries: [], diagnostics: [{ ref: 'entry:1', code: 'render-failed' }] }) })
  const result = await search('s', { refs: ['entry:1', 'entry:3'] })
  assert.deepEqual(result.entries.map(e => [e.status, e.text]), [['render-error', ''], ['empty', '']])
})

test('explicit Chinese phrases remain intact and named-entry titles outrank broad full-text matches', async () => {
  const search = createWorldbookSearch({ load: async () => ({ worldBook: { view: { entries: [
    { ref: 'overview', title: '诸派总览', content: '少林 武当 门规 主修经脉' },
    { ref: 'noise', title: '武者', content: '当时有人讲规矩，经常修炼' },
    { ref: 'wudang', title: '门派·武当', content: '内家拳传承' },
    { ref: 'shaolin', title: '门派·少林', content: '禅武传承' }
  ] } } }), render: () => { throw new Error('search must not render') } })
  for (const [name, ref] of [['武当', 'wudang'], ['少林', 'shaolin']]) {
    const result = await search('s', { query: name + ' 门规 主修经脉' })
    assert.equal(result.entries[0].ref, ref)
    assert.equal(result.entries.some(entry => entry.ref === 'noise'), false)
  }
})
