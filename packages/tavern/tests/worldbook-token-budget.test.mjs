import test from 'node:test'
import assert from 'node:assert/strict'
import { createForegroundWorldbook } from '../tavern-plugin/lib/domain/foreground-worldbook.js'
import { UpstreamTemplateRuntime } from './fixtures/upstream-template-runtime.mjs'
import { inspectWorldBookDocument, updateWorldBookDocument, exportCharacterBook, exportSillyTavernWorldBook } from '../tavern-plugin/lib/domain/worldbook-resource.js'
const runtime = await UpstreamTemplateRuntime.create()
const e = (ref, content, order = 100, extra = {}) => ({ ref, content, order, enabled: true, primaryKeys: ['地点'], ...extra })
const project = (entries, token_budget) => createForegroundWorldbook({ bound: async () => ({ view: { entries, raw: { token_budget } } }), runtime: async () => runtime, globalVariables: async () => ({}) })({ chat: { messages: [] }, card: {}, userText: '地点' })

test('短条目可以超过五条；日志报告实际渲染成本而不是模板源码成本', async () => {
  const result = await project(Array.from({length:12}, (_,i) => e('条目'+i, '<% /* ' + '长注释'.repeat(100) + ' */ %>短')), 36)
  assert.equal(result.error, null)
  assert.equal(result.refs.length, 12)
  assert.equal(result.log.budget.used, 36)
  assert.equal(result.log.budget.estimator, 'unicode-estimate')
  assert.ok(result.log.outputs.every(output => output.text === '短'))
})
test('长模板按实际输出挡住，按作者顺序停止，不跳过长条目去捡低优先级短条目', async () => {
  const result = await project([e('先', '一', 300), e('长', '<%= "长".repeat(100) %>', 200), e('后', '后', 100)], 10)
  assert.deepEqual(result.refs, ['先'])
  const long = result.log.entries.find(e => e.ref === '长')
  assert.equal(long.reason, 'budget')
  assert.equal(long.tokenCost, 102)
  assert.equal(long.budgetUsed, 3)
  assert.equal(result.log.entries.find(e => e.ref === '后').overflowedEarlier, true)
  assert.equal(result.reads.长, undefined)
})
test('零预算关闭非常驻召回，常驻标签保持原有路径', async () => {
  const result = await project([e('常驻', '基础规则', 300, {constant:true}), e('动态', '资料')], 0)
  assert.deepEqual(result.refs, [])
  assert.equal(result.context, '')
  assert.equal(result.prefixContext, '基础规则')
  assert.equal(result.log.budget.used, 0)
  assert.equal(result.log.entries.find(e => e.ref === '动态').reason, 'budget')
})
test('预算设置在嵌入与独立格式编辑导出后仍生效，非法输入不静默截断', async () => {
  const original = { entries: { 0: {uid:0, key:['地点'],content:'正文'} } }
  const updated = updateWorldBookDocument(original, {tokenBudget:1234,scanDepth:1}).document
  const exported = exportSillyTavernWorldBook(exportCharacterBook(updated))
  const view = inspectWorldBookDocument(exported)
  assert.equal(view.tokenBudget,1234)
  assert.equal(view.raw.token_budget,1234)
  assert.equal(view.scanDepth,1)
  assert.equal(original.token_budget,undefined)
  for(const tokenBudget of [-1,1.5,1000001]) assert.throws(()=>updateWorldBookDocument(original,{tokenBudget}),/Token 预算/)
})

test('软预算允许最后一条完整跨线，但不超过两倍硬上限', async () => {
  const result = await project([e('先', '一'.repeat(5), 300), e('跨线', '二'.repeat(7), 200), e('后', '后', 100)], 10)
  assert.deepEqual(result.refs, ['跨线', '先'])
  assert.equal(result.log.outputs.find(o => o.ref === '跨线').text, '二'.repeat(7))
  assert.equal(result.log.budget.used, 16)
  assert.equal(result.log.budget.hardLimit, 20)
  assert.equal(result.log.entries.find(e => e.ref === '后').budgetReason, 'soft-limit-reached')
  const huge = await project([e('超大', '字'.repeat(19)), e('后', '后', 1)], 10)
  assert.deepEqual(huge.refs, [])
  assert.equal(huge.log.entries.find(e => e.ref === '超大').budgetReason, 'hard-limit')
})
