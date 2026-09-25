import test from 'node:test'
import assert from 'node:assert/strict'
import { UpstreamTemplateRuntime } from './fixtures/upstream-template-runtime.mjs'
import { createForegroundWorldbook } from '../tavern-plugin/lib/domain/foreground-worldbook.js'

const runtime = await UpstreamTemplateRuntime.create()
let nextUid = 1000
const entry = (ref, extra = {}) => ({ ref, sourceUid: nextUid++, title: ref, comment: ref, enabled: true, constant: false,
  primaryKeys: [], secondaryKeys: [], order: 100, content: '正文 ' + ref, ...extra })
const controller = (ref, content) => entry(ref, { constant: true, enabled: false, order: 500, content: '@@generate_before\n' + content })
const project = (entries, raw = {}) => createForegroundWorldbook({ bound: async () => ({ view: { displayName: '绑定书', entries, raw } }), runtime: async () => runtime, globalVariables: async () => ({}) })

test('变量驱动的选角调度使用同一关键词规则，强制入选后真实渲染且记录来源', async () => {
  const entries = [controller('调度', `<% const all = await getEnabledWorldInfoEntries();
    const leaves = all.filter(e => e.comment.startsWith('名册·'));
    for (const leaf of selectActivatedEntries(leaves, getvar('stat_data.地点'))) await activewi(leaf.comment, true); %>`),
    entry('叶', { title: '名册·少林', comment: '名册·少林', primaryKeys: ['少林'], secondaryKeys: ['/夜/'], selective: true, content: '<%= getvar("stat_data.地点") %>的名册' }),
    entry('无关', { comment: '名册·武当', primaryKeys: ['武当'] })]
  const chat = { messages: [], variables: { stat_data: { 地点: '少林夜' } } }
  const result = await project(entries)({ chat, card: {}, userText: '看看四周' })
  assert.equal(result.error, null)
  assert.match(result.context, /少林夜的名册/)
  assert.deepEqual(result.refs, ['叶'])
  assert.equal(result.log.entries.find(e => e.ref === '叶').activationRequests[0].sourceRef, '[GENERATE:BEFORE]')
  assert.ok(result.reads.叶)
  assert.deepEqual(chat.variables, { stat_data: { 地点: '少林夜' } })
  const miss = await project(entries)({ chat: { ...chat, variables: { stat_data: { 地点: '少林昼' } } }, card: {}, userText: '看看四周' })
  assert.deepEqual(miss.refs, [])
})

test('主动激活仍受token 预算和既有冷却约束；重投影不重复累加变量', async () => {
  const entries = [controller('调度', '<% incvar("count"); for (const e of await getEnabledWorldInfoEntries()) if (!e.constant) await activewi("绑定书", e.uid, true); %>'),
    ...Array.from({ length: 6 }, (_, i) => entry('叶' + i, { order: 110 - i, content: '<%= getvar("count", {defaults:0}) %> 叶' + i }))]
  const run = project(entries, { token_budget: 20 })
  const first = await run({ chat: { messages: [{ role: 'assistant', turn: 1, text: '' }] }, card: {}, userText: '无关键词' })
  assert.equal(first.error, null)
  assert.equal(first.refs.length, 5, JSON.stringify({refs:first.refs, outputs:first.log.outputs}))
  assert.equal(first.log.entries.find(e => e.ref === '叶5').reason, 'budget')
  // Upstream generate-before controllers run before the native candidate projection; increments remain speculative.
  assert.ok(first.log.outputs.every(o => /^1 叶/.test(o.text)))
  const second = await run({ chat: { worldBookReads: first.reads, messages: [{ role: 'assistant', turn: 2, text: '' }] }, card: {}, userText: '无关键词' })
  assert.deepEqual(second.refs, ['叶5'])
  assert.equal(second.log.entries.find(e => e.ref === '叶0').reason, 'cooldown')
})

test('嵌套调度去重；force 可选禁用叶，MVU 不进入前台；控制器异常保留上游已发生的激活副作用', async () => {
  const entries = [controller('调度', '<% await activewi("嵌套", true); await activewi("嵌套", true); await activewi("31b_[mvu_update]规则", true); %>'),
    controller('失败', '<% await activewi("不可见", true); throw new Error("fail"); %>'),
    entry('嵌套', { content: '<% await activewi("停用叶", true) %>嵌套正文' }),
    entry('停用叶', { enabled: false, content: '最终叶正文' }), entry('不可见'),
    entry('规则', { title: '31b_[mvu_update]规则', comment: '31b_[mvu_update]规则', content: '后台协议' })]
  const result = await project(entries)({ chat: { messages: [] }, card: {}, userText: '' })
  assert.equal(result.error, null)
  assert.equal((result.context.match(/最终叶正文/g) || []).length, 1, JSON.stringify(result))
  assert.match(result.context, /嵌套正文/)
  assert.doesNotMatch(result.context, /后台协议/)
  assert.match(result.context, /正文 不可见/)
  assert.deepEqual(new Set(result.refs), new Set(['嵌套', '停用叶', '不可见']))
  assert.equal(result.log.entries.find(e => e.ref === '停用叶').rendering, 'rendered')
  assert.equal(result.log.entries.find(e => e.ref === '不可见').activationRequests[0].sourceRef, '[GENERATE:BEFORE]')
})

test('非强制调用保留关键词条件；别名与正则标题正确定位，缺失条目返回 null', async () => {
  const entries = [controller('调度', `<% await activateWorldInfo('未命中');
    await activateWorldInfo(/^停用/, true);
    if (await activewi('不存在', true) !== null) throw new Error('missing');
    const found = selectActivatedEntries(await getEnabledWorldInfoEntries(), '关口', { disabled: false, constant: false });
    for (const e of found) await activewi(e.comment, true); %>`),
    entry('未命中', { primaryKeys: ['秘密'] }), entry('停用', { enabled: false }),
    entry('主副键', { primaryKeys: ['关口'], secondaryKeys: ['/夜/'], selective: true }),
    entry('正则', { primaryKeys: ['/关[口卡]/'] })]
  const result = await project(entries)({ chat: { messages: [] }, card: {}, userText: '看看' })
  assert.equal(result.error, null)
  assert.deepEqual(new Set(result.refs), new Set(['停用', '正则']))
  assert.equal(result.log.entries.find(e => e.ref === '未命中').reason, 'keywords')
  assert.equal(result.log.entries.find(e => e.ref === '主副键').reason, 'keywords')
})
