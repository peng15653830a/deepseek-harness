import test from 'node:test'
import assert from 'node:assert/strict'
import { createForegroundWorldbook } from '../tavern-plugin/lib/domain/foreground-worldbook.js'
import { projectWorldBookTemplates } from '../tavern-plugin/lib/domain/worldbook-recall.js'
import { UpstreamTemplateRuntime } from './fixtures/upstream-template-runtime.mjs'
import { entryRandom, renderWorldbookRandom } from '../tavern-plugin/lib/domain/worldbook-random.js'

const runtime = await UpstreamTemplateRuntime.create()
test('固定前缀稳定，随机位置完整追加；同轮复用、新轮刷新且不进入冷却', async () => {
  const entries = [
    { ref: 'fixed', constant: true, content: '固定规则', position: 4, depth: 2, order: 5 },
    { ref: 'open', constant: true, content: '<角色库>', position: 4, depth: 2, order: 10 },
    { ref: 'pool', constant: true, content: '<%= Math.random() %> {{roll 1d20}} {{random::甲,乙}}', position: 4, depth: 2, order: 20 },
    { ref: 'close', constant: true, content: '</角色库>', position: 4, depth: 2, order: 30 }
  ].map(e => ({ enabled: true, ...e }))
  const worldBook = { view: { entries } }
  const project = createForegroundWorldbook({ bound: async () => worldBook, runtime: async () => runtime, globalVariables: async () => ({}) })
  const chat = { messages: [{ role: 'assistant', greeting: true, turn: 1, text: '开场' }] }
  const a = await project({ chat, card: {}, userText: '继续' })
  assert.equal(a.error, null)
  assert.equal(a.prefixContext, '固定规则')
  assert.match(a.context, /^<角色库>\n\n0\.\d+ \d+ [甲乙]\n\n<\/角色库>$/)
  assert.deepEqual(a.refs, [])
  chat.worldBookRandomState = a.randomState
  const repeat = await project({ chat, card: {}, userText: '继续' })
  assert.equal(repeat.context, a.context)
  const background = await projectWorldBookTemplates({ worldBook, runtime, includeConstants: true, chat, card: {}, randomSeed: 'different-background-seed', randomOutputs: a.randomState.outputs })
  assert.equal(background.foregroundContext, a.context)
  chat.messages.push({ role: 'assistant', turn: 2, text: '正文' })
  const b = await project({ chat, card: {}, userText: '继续' })
  assert.equal(b.prefixContext, a.prefixContext)
  assert.notEqual(b.context, a.context)
})
test('世界书骰子宏支持空格与双冒号，数值在骰面范围内', async () => {
  const result = renderWorldbookRandom('{{roll 1d20}} {{roll::2d6+3}} {{random::甲::乙}}', () => 0)
  assert.equal(result, '1 5 甲')
  assert.equal(entryRandom('seed', 'ref')(), entryRandom('seed', 'ref')())
})

test('只迁移实际包裹区间，同位置独立固定段不随绿灯或随机条目移动', async () => {
  const { foregroundWorldbookRefs } = await import('../tavern-plugin/lib/domain/worldbook-placement.js')
  const entries = [
    ['fixed-before', '<规则>固定</规则>', true],
    ['open', '<外层><角色库>', true],
    ['role', '角色资料', false],
    ['close', '</角色库></外层>', true],
    ['fixed-after', '固定尾段', true],
    ['random', '{{roll 1d20}}', true]
  ].map(([ref, content, constant], index) => ({ ref, content, constant, order: index, position: 0, enabled: true }))
  assert.deepEqual([...foregroundWorldbookRefs(entries)].sort(), ['close', 'open', 'random', 'role'])
})

test('固定概览留在完整前缀中，本轮只重复标签和随机正文', async () => {
  const entries = [
    ['open', '<种族>'], ['overview', '固定种族概览'],
    ['inner', '<角色库>'], ['fixed-role', '固定角色说明'],
    ['random', '{{roll 1d20}}'], ['end-inner', '</角色库>'], ['close', '</种族>']
  ].map(([ref, content], order) => ({ ref, content, order, constant: true, enabled: true }))
  const project = async seed => await projectWorldBookTemplates({ worldBook: { view: { entries } }, runtime, includeConstants: true, randomSeed: seed })
  const a = await project('a'), b = await project('b')
  assert.equal(a.prefixContext, '<种族>\n\n固定种族概览\n\n<角色库>\n\n固定角色说明\n\n</角色库>\n\n</种族>')
  assert.equal(a.prefixContext, b.prefixContext)
  assert.match(a.foregroundContext, /^<种族>\n\n<角色库>\n\n\d+\n\n<\/角色库>\n\n<\/种族>$/)
  assert.equal(a.renderedEntries.find(e => e.ref === 'open').alsoInPrefix, true)
})

test('标签与说明混写的边界不强行拆分', async () => {
  const { worldbookPlacement } = await import('../tavern-plugin/lib/domain/worldbook-placement.js')
  const entries = [['open', '<种族>以下规则适用于本组'], ['fixed', '固定说明'], ['random', '{{roll 1d20}}'], ['close', '</种族>']]
    .map(([ref, content], order) => ({ ref, content, order, constant: true, enabled: true }))
  const placement = worldbookPlacement(entries)
  assert.equal(placement.prefixRefs.size, 0)
  assert.equal(placement.foregroundRefs.size, 4)
})

test('常驻状态模板随轮追加，存档时间变化不改固定前缀', async () => {
  const worldBook = { view: { entries: [
    { ref: 'fixed', content: '固定世界规则{{getvar::config}}', constant: true, enabled: true },
    { ref: 'state', content: '<状态><%= getMessageVar("clock") %></状态>', constant: true, enabled: true }
  ] } }
  const render = async clock => await projectWorldBookTemplates({ worldBook, runtime, includeConstants: true,
    chat: { messages: [{ role: 'assistant', variables: [{ clock }] }] } })
  const a = await render('09:10'), b = await render('09:12')
  assert.equal(a.prefixContext, '固定世界规则')
  assert.equal(b.prefixContext, a.prefixContext)
  assert.equal(a.foregroundContext, '<状态>09:10</状态>')
  assert.equal(b.foregroundContext, '<状态>09:12</状态>')
})
