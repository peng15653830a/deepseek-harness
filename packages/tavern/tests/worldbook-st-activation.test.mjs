import test from 'node:test'
import assert from 'node:assert/strict'
import { prepareWorldBookRecall, projectWorldBookTemplates } from '../tavern-plugin/lib/domain/worldbook-recall.js'
import { inspectWorldBookDocument, updateWorldBookDocument, exportCharacterBook, exportSillyTavernWorldBook } from '../tavern-plugin/lib/domain/worldbook-resource.js'
import { createForegroundWorldbook } from '../tavern-plugin/lib/domain/foreground-worldbook.js'
import { UpstreamTemplateRuntime } from './fixtures/upstream-template-runtime.mjs'

const runtime = await UpstreamTemplateRuntime.create()

const e = (uid, key, extra = {}) => ({ uid, key: [key], content: '设定' + uid, order: 100, ...extra })
const book = (entries, settings = {}) => ({ view: inspectWorldBookDocument({ ...settings, entries: Object.fromEntries(entries.map(entry => [entry.uid, entry])) }) })
const recall = (entries, options = {}, settings = {}) => prepareWorldBookRecall({ worldBook: book(entries, settings), turn: 2, chat: { messages: [] }, ...options })

test('当前玩家输入参与匹配，单词不会拆成字母，默认窗口不读取全部历史', async () => {
  const entries = [e(0, 'Alice'), e(1, '矿井'), e(2, 'a', { matchWholeWords: true })]
  const chat = { messages: [{ role: 'assistant', text: '矿井' }, { role: 'user', text: '走吧' }, { role: 'assistant', text: '晴天' }] }
  assert.deepEqual(recall(entries, { chat, userText: 'Alice' }).refs, ['entry:0'])
  assert.deepEqual(recall(entries, { userText: 'A local ice shop' }).refs, ['entry:2'])
  assert.deepEqual(recall(entries, { userText: 'place' }).refs, [])
})
test('世界书扫描深度和条目覆盖按消息数生效，0 禁止扫描', async () => {
  const entries = [e(0, '矿井'), e(1, '矿井', { scanDepth: 1 }), e(2, '矿井', { scanDepth: 0 })]
  const chat = { messages: [{ role: 'assistant', text: '矿井' }, { role: 'assistant', text: '晴天' }] }
  assert.deepEqual(recall(entries, { chat, userText: '继续' }, { scan_depth: 3 }).refs, ['entry:0'])
  assert.deepEqual(recall(entries, { chat, userText: '继续' }).refs, [])
})
test('递归只读取已入选正文，支持阻断、排除和延迟等级', async () => {
  const entries = [e(0, 'start', { content: 'secret' }), e(1, 'secret', { content: 'end' }),
    e(2, 'end', { excludeRecursion: true }), e(3, 'end', { delayUntilRecursion: 2 })]
  assert.deepEqual(new Set(recall(entries, { userText: 'start' }, { recursive_scanning: true }).refs), new Set(['entry:0', 'entry:1', 'entry:3']))
  assert.deepEqual(recall(entries, { userText: 'start' }).refs, ['entry:0'])
  entries[0].preventRecursion = true
  assert.deepEqual(recall(entries, { userText: 'start' }, { recursive_scanning: true }).refs, ['entry:0'])
})
test('常驻条目可触发递归；未入选条目不能把隐藏正文带入扫描', async () => {
  const entries = [e(0, '', { constant: true, content: 'Alice' }), e(1, 'Alice')]
  assert.deepEqual(recall(entries, {}, { recursive_scanning: true }).refs, ['entry:1'])
  const overflow = Array.from({ length: 6 }, (_, uid) => e(uid, 'start', { order: uid, content: uid === 0 ? 'hidden' : '普通内容' }))
  overflow.push(e(9, 'hidden', { order: 999 }))
  const result = recall(overflow, { userText: 'start' }, { recursive_scanning: true, token_budget: 30 })
  assert.equal(result.refs.length, 5)
  assert.ok(!result.refs.includes('entry:9'))
  assert.equal(result.diagnostics.find(item => item.ref === 'entry:0').reason, 'budget')
})
test('包含组支持优先级、权重、计分和多个组，不会重复入选', async () => {
  const entries = [e(0, 'Alice', { group: '角色', groupOverride: true, order: 10 }), e(1, 'Alice', { group: '角色', order: 200 })]
  assert.deepEqual(recall(entries, { userText: 'Alice' }).refs, ['entry:0'])
  entries[0].groupOverride = false
  entries[0].groupWeight = 0
  assert.deepEqual(recall(entries, { userText: 'Alice', random: () => 0.4 }).refs, ['entry:1'])
  entries[0].key = ['Alice', 'Bob']; entries[0].useGroupScoring = true; entries[0].groupWeight = 100
  entries[1].useGroupScoring = true
  assert.deepEqual(recall(entries, { userText: 'Alice Bob' }).refs, ['entry:0'])
  entries[0].group = '角色, 人物'
  entries.push(e(2, 'Alice', { group: '人物', useGroupScoring: true }))
  assert.deepEqual(recall(entries, { userText: 'Alice Bob' }).refs, ['entry:0'])
})
test('单汉字使用独立边界，多词短语保留原有匹配', async () => {
  assert.deepEqual(recall([e(0, '雨', { matchWholeWords: true }), e(1, 'New York', { matchWholeWords: true })], { userText: '下雨了，New Yorkshire' }).refs, ['entry:1'])
})
test('扫描和分组设置在独立、嵌入格式往返时保留，编辑不修改原文件', async () => {
  const original = { entries: { 0: e(0, 'Alice') } }
  const updated = updateWorldBookDocument(original, { scanDepth: 8, recursiveScanning: true, operations: [{ op: 'update', ref: 'entry:0', patch: { scanDepth: 4, group: '角色', groupOverride: true, groupWeight: 20, useGroupScoring: true } }] }).document
  const exported = exportSillyTavernWorldBook(exportCharacterBook(updated))
  const view = inspectWorldBookDocument(exported)
  assert.equal(view.scanDepth, 8)
  assert.equal(view.recursiveScanning, true)
  assert.equal(view.entries[0].groupOverride, true)
  assert.equal(view.entries[0].groupWeight, 20)
  assert.equal(view.entries[0].useGroupScoring, true)
  assert.equal(view.entries[0].scanDepth, 4)
  assert.equal(original.scan_depth, undefined)
})

test('正式前台投影：蓝灯标签包住绿灯角色，系统前缀无重复，同一轮重试无重复冷却', async () => {
  const worldBook = book([e(0, '', { constant: true, order: 10, content: '<角色库>' }),
    e(1, 'Alice', { order: 20, content: 'Alice 的资料' }), e(2, '', { constant: true, order: 30, content: '</角色库>' }),
    e(3, '', { constant: true, position: 1, content: '通用规则' })])
  const project = createForegroundWorldbook({ bound: async () => worldBook, runtime: async () => runtime, globalVariables: async () => ({}) })
  const chat = { messages: [{ role: 'assistant', text: '天气晴朗', turn: 1 }] }
  const first = await project({ chat, card: {}, userText: '找 Alice' })
  assert.equal(first.error, null)
  assert.equal(first.context, '<角色库>\n\nAlice 的资料\n\n</角色库>')
  assert.equal(first.prefixContext, '通用规则')
  chat.worldBookReads = first.reads; chat.preparedWorldBook = first.activation
  assert.equal((await project({ chat, card: {}, userText: '找 Alice' })).context, first.context)
  chat.messages.push({ role: 'assistant', text: 'Alice 来了', turn: 2 })
  const second = await project({ chat, card: {}, userText: '继续' })
  assert.equal(second.context, '<角色库>\n\n</角色库>')
  assert.equal(second.reads['entry:1'].turn, 1)
  const prefixOnly = await projectWorldBookTemplates({ worldBook, runtime, includeConstants: true, chat, card: {} })
  assert.equal(prefixOnly.prefixContext, '通用规则')
})
test('失败的绿灯 EJS 不泄露源码、不消耗冷却；脚本扫描与玩家输入共享 token 预算', async () => {
  const entries = Array.from({ length: 6 }, (_, uid) => e(uid, uid > 2 ? 'script' : 'player', { order: uid }))
  entries.push(e(9, 'player', { content: '<% if ( %>', order: 999 }))
  const project = createForegroundWorldbook({ bound: async () => book(entries, { token_budget: 20 }), runtime: async () => runtime, globalVariables: async () => ({}), scanText: () => 'script' })
  const result = await project({ chat: { messages: [] }, card: {}, userText: 'player' })
  assert.equal(result.refs.length, 4)
  assert.equal(result.reads['entry:9'], undefined)
  assert.doesNotMatch(result.context, /<%/)
  assert.equal(result.diagnostics[0].code, 'syntax-error')
})

test('开场白不触发关键词，当前输入和后续正文仍触发', async () => {
  const entries = [e(0, '武当'), e(1, '少林'), e(2, '', { constant: true })]
  const chat = { messages: [{ role: 'assistant', greeting: true, text: '武当、少林任选出身' }] }
  const before = JSON.stringify(chat)
  const opening = recall(entries, { chat })
  assert.deepEqual(opening.refs, [])
  assert.ok(opening.entries.some(entry => entry.constant))
  assert.deepEqual(opening.scanSources, [])
  assert.deepEqual(recall(entries, { chat, userText: '去少林' }).refs, ['entry:1'])
  assert.equal(JSON.stringify(chat), before)
  chat.messages.push({ role: 'user', text: '继续' }, { role: 'assistant', text: '武当来客到了' })
  assert.deepEqual(recall(entries, { chat }).refs, ['entry:0'])
})


test('单汉字简称不命中词内片段，独立称呼和作者正则仍可命中', async () => {
  const entries = [e(0, '白'), e(1, '都'), e(2, '袖白雪'), e(3, '/白/')]
  assert.deepEqual(new Set(recall(entries, { userText: '袖白雪发出白光，你连站的地方都选错了' }).refs), new Set(['entry:2', 'entry:3']))
  assert.deepEqual(new Set(recall(entries, { userText: '白，你先走；都！' }).refs), new Set(['entry:0', 'entry:1', 'entry:3']))
  for (const text of ['白走了', '小白', 'A白', '白1', '_白', '白\u0301']) assert.deepEqual(recall([e(0, '白')], { userText: text }).refs, [])
  assert.deepEqual(recall([e(0, '白')], { userText: '白' }).refs, ['entry:0'])
})
