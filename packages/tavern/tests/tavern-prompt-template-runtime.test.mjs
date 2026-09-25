import assert from 'node:assert/strict'
import test from 'node:test'

import { UpstreamTemplateRuntime } from './fixtures/upstream-template-runtime.mjs'

const runtime = await UpstreamTemplateRuntime.create()

test('上游保留 XML 标签并执行条件、循环与 print', async () => {
  const result = await runtime.render('<%= html %>|<%- html %>|<% if (show) { for (const item of items) print(item) } %>', {
    locals: { html: '<b>x</b>', show: true, items: ['甲', '乙'] }
  })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.text, '<b>x</b>|<b>x</b>|甲乙')
})

test('模板变量按 global initial local message 优先级合并并可持久修改作用域', async () => {
  const result = await runtime.render([
    '<%= variables.value %>',
    '<% setGlobalVar("globalOnly", 2) %>',
    '<% setLocalVar("localOnly", 3) %>',
    '<% setvar("value", 5) %>',
    '<%= getGlobalVar("globalOnly") + getLocalVar("localOnly") + getMessageVar("value") %>'
  ].join(''), {
    scopes: {
      global: { value: 1 }, initial: { value: 2 }, local: { value: 3 }, message: { value: 4 }
    }
  })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.text, '410')
  assert.equal(result.scopes.global.globalOnly, 2)
  assert.equal(result.scopes.local.localOnly, 3)
  assert.equal(result.scopes.message.value, 5)
})

test('同一请求内按消息顺序传播模板变量更新', async () => {
  const result = await runtime.renderMessages([
    { role: 'system', content: '<% setLocalVar("mode", "仙侠") %>' },
    { role: 'user', content: '<%= getLocalVar("mode") %>' }
  ], { scopes: { local: {} } })
  assert.deepEqual(result.messages.map(item => item.content), ['', '仙侠'])
  assert.equal(result.scopes.local.mode, '仙侠')
  assert.equal(result.evaluated, 2)
})

test('模板在浏览器环境执行，不提供 Node 进程对象', async () => {
  const result = await runtime.render('<%= typeof process %>|<%= typeof require %>|<%= typeof fetch %>')
  assert.equal(result.text, 'undefined|undefined|function')
})

test('语法错误返回上游错误，后续模板仍可执行', async () => {
  assert.equal((await runtime.render('<% if ( %>')).ok, false)
  assert.equal((await runtime.render('<%= 1 + 1 %>')).text, '2')
})

test('YAML、聊天记录、世界书读取和 lodash 常用函数可用', async () => {
  const result = await runtime.render([
    '<%= _.get(variables, "stat_data.hp") %>|',
    '<%= lastUserMessage %>|',
    '<%- (await getwi("规则")).trim() %>|',
    '<%- YAML.stringify({ a: 1 }).trim() %>'
  ].join(''), {
    scopes: { message: { stat_data: { hp: 9 } } },
    transcript: [{ role: 'user', content: '行动' }],
    worldBookEntries: [{ id: '1', name: '规则', comment: '规则', content: '遵守设定' }]
  })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.text, '9|行动|遵守设定|a: 1')
})

test('从世界书专用条目初始化 EJS 变量且不接受普通条目', async () => {
  const result = await runtime.initializeVariables([
    { enabled: true, comment: '普通条目', content: 'ignored: true' },
    { enabled: false, comment: '[InitialVariables] 基础', content: '角色:\n  体力: 10\n  标签: [旧]' },
    { enabled: false, comment: '装饰器', content: '@@initial_variables\n角色:\n  标签: [新]\n模式: <%= "仙侠" %>' }
  ])
  assert.deepEqual(result.initial, { 角色: { 体力: 10, 标签: ['新'] }, 模式: '仙侠' })
  assert.deepEqual(result.diagnostics, [])
})

test('模板历史读取支持前 N 条、末 N 条及角色过滤，不把负数误当全部历史', async () => {
  const transcript = Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: String(i) }))
  const result = await runtime.render('<%- JSON.stringify([getChatMessages(-5), getChatMessages(2), getChatMessages(-2,"user"), getChatMessages(1,3), getChatMessages(0)]) %>', { transcript })
  assert.equal(result.ok, true, result.error)
  assert.deepEqual(JSON.parse(result.text), [['3','4','5','6','7'], ['0','1'], ['4','6'], ['1','2'], []])
})

test('完整 Lodash 支持状态筛选与地图索引', async () => {
  const result = await runtime.render(`<% const data = _.omit(_.cloneDeep(source), '事件');
    data.people = _.mapValues(_.omitBy(data.people, p => p._隐藏), p => _.omit(p, '_隐藏'));
    const visible = _.chain([{level: 13, fields: ['要素']}, {level: 17, fields: ['权能']}]).filter(t => t.level <= 13).flatMap('fields').value();
    const places = _.keyBy([{id: 'inn', name: '旅店'}], 'id');
    print(JSON.stringify({data, visible, place: places.inn.name, process: typeof process, require: typeof require})); %>`, {
    locals: { source: { 事件: '内部', people: { visible: { name: '甲', _隐藏: false }, hidden: { name: '乙', _隐藏: true } } } }
  })
  assert.equal(result.ok, true, result.error)
  assert.deepEqual(JSON.parse(result.text), { data: { people: { visible: { name: '甲' } } }, visible: ['要素'], place: '旅店', process: 'undefined', require: 'undefined' })
})


test('真实请求处理保留工具与推理块，并处理独立 system 和正文模板', async () => {
  const message = { id: 'message', role: 'assistant', content: [
    { type: 'reasoning', text: 'retained' }, { type: 'text', text: '<%= 6 * 7 %>' },
    { type: 'tool-call', id: 'tool-id', name: 'inspect', arguments: { value: 1 } }
  ] }
  const result = await runtime.projectRequest({ system: '规则 <%= 1+1 %>', messages: [message] })
  assert.equal(result.system, '规则 2')
  assert.equal(result.messages[0].id, 'message')
  assert.deepEqual(result.messages[0].content, [message.content[0], { type: 'text', text: '42' }, message.content[2]])
  assert.equal(message.content[1].text, '<%= 6 * 7 %>')
})
