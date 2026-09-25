import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
const source = readFileSync(new URL('../tavern-plugin/src/client/main.js', import.meta.url), 'utf8')
const start = source.indexOf('function requestContextSections(')
const end = source.indexOf('function FullRequestContextView(', start)
const sections = vm.runInNewContext('(' + source.slice(start, end).trim() + ')')
test('system and tools precede messages while message, block and tool order remain unchanged', () => {
  const request = { tools: [{name:'z'}, {name:'a'}], messages: [
    {role:'user', content:[{type:'text',text:'first'}, {type:'text',text:'second'}]},
    {role:'assistant', content:[{type:'tool-call',id:'z'}, {type:'tool-call',id:'a'}]},
    {role:'tool', content:[{id:'a'}, {id:'z'}]},
    {role:'system', content:[], source:{sections:[{name:'tavern:runtime-preset-front'}]}}
  ], system:'', model:'fixture' }
  const before = JSON.stringify(request)
  const rows = sections(request)
  assert.deepEqual(Array.from(rows, r=>r.title.split(' · ')[0]), ['调用参数','system','tools','messages[0]','messages[1]','messages[2]','messages[3]'])
  rows.slice(3,7).forEach((row,i)=>assert.equal(JSON.stringify(row.value),JSON.stringify(request.messages[i])))
  assert.equal(rows[2].text,JSON.stringify(request.tools,null,2))
  assert.equal(rows[1].value,'')
  assert.equal(JSON.stringify(request),before)
  assert.equal(sections({messages:[]})[0].text,'[]')
})

test('tools follow only the leading system messages, retaining indices and exact request JSON', () => {
  for (const leading of [1, 2]) {
    const request = { model: 'fixture', tools: [{ name: 'lookup' }], messages: [
      ...Array.from({ length: leading }, (_, i) => ({ role: 'system', content: 'preset-' + i })),
      { role: 'user', content: 'input' },
      { role: 'system', content: 'later system stays here' },
      { role: 'assistant', content: 'reply' }
    ] }
    const before = JSON.stringify(request)
    const rows = sections(request)
    assert.deepEqual(Array.from(rows, row => row.title.split(' · ')[0]), [
      '调用参数', ...Array.from({ length: leading }, (_, i) => `messages[${i}]`), 'tools',
      ...Array.from({ length: 3 }, (_, i) => `messages[${leading + i}]`)
    ])
    assert.deepEqual(Array.from(rows.filter(row => row.title.startsWith('messages[')), row => row.value), request.messages)
    assert.equal(JSON.stringify(request), before)
  }
})

test('message body excludes provenance duplication and counts only displayed content', () => {
  const request = { messages: [{ role: 'system', id: 'one', content: [
    { type: 'text', text: 'same prompt' },
    { type: 'text', text: 'same prompt' }
  ], source: { sections: [{ name: 'preset', text: 'same prompt' }] } }] }
  const before = JSON.stringify(request)
  const [row] = sections(request)
  assert.deepEqual(Array.from(row.body), ['same prompt', 'same prompt'])
  assert.equal(row.count, 22)
  assert.equal(row.text, 'same prompt\n\nsame prompt')
  assert.deepEqual(JSON.parse(row.metadataText), { id: 'one', source: request.messages[0].source })
  assert.equal(JSON.stringify(request), before)
})

test('mixed content keeps block order and full nontext or annotated text data', () => {
  const blocks = [
    { type: 'text', text: 'before' },
    { type: 'tool-call', id: 'call', arguments: { query: 'x' } },
    { type: 'image', url: 'fixture.png' },
    { type: 'text', text: 'annotated', annotations: ['keep'] },
    { type: 'text', text: 'after' }
  ]
  const [row] = sections({ messages: [{ role: 'assistant', content: blocks }] })
  assert.deepEqual(Array.from(row.body), ['before', ...blocks.slice(1, 4).map(block => JSON.stringify(block, null, 2)), 'after'])
  assert.equal(row.metadataText, '{}')
})

test('merged host skill catalog has a separate display fold without changing bytes or order', () => {
  const catalog = '<system-reminder>\nA skill is a reusable set of task-specific instructions. The following skills are available in this session:\n\n<available_skills>fixture</available_skills>\n</system-reminder>'
  const content = 'player input\n\n' + catalog + '\ntrailing text'
  const request = { messages: [{ role: 'user', content: [{ type: 'text', text: content }], source: { kind: 'user' } }] }
  const before = JSON.stringify(request)
  const [row] = sections(request)
  assert.equal(row.displayParts.length, 3)
  assert.equal(row.displayParts[1].label, '系统附加 · Skill 目录')
  assert.equal(row.displayParts[1].catalog, true)
  assert.equal(row.body.join(''), content)
  assert.equal(row.count, content.length)
  assert.equal(JSON.stringify(request), before)
  const [ordinary] = sections({ messages: [{ role: 'user', content: '<system-reminder>user text</system-reminder>' }] })
  assert.equal(ordinary.displayParts[0].catalog, undefined)
})

test('merged preset tail labels only its own content and preserves the whole message', () => {
  const content = 'player input\n\nwriting rules\n\npreset tail'
  const request = { messages: [{ role: 'user', content: [{ type: 'text', text: content }], source: { kind: 'user', sections: [
    { name: 'tavern:foreground:writingRules:1', text: 'writing rules' },
    { name: 'tavern:runtime-preset-back', text: 'preset tail' }
  ] } }] }
  const before = JSON.stringify(request)
  const rows = sections(request)
  assert.match(rows[1].title, /预设后段/)
  assert.equal(rows[1].body.join(''), 'preset tail')
  assert.equal(rows.flatMap(row => Array.from(row.body)).join(''), content)
  assert.equal(rows.reduce((sum, row) => sum + row.count, 0), content.length)
  assert.equal(JSON.stringify(request), before)
  request.messages[0].source.sections[0].text = 'missing provenance'
  assert.equal(sections(request)[0].body[0], content)
})

 test('front and back presets are independent folds in their original positions', () => {
  const message = { role: 'system', content: 'front1\n\nfront2\n\nsystem body\n\nback', source: { sections: [
    { name: 'tavern:runtime-preset-front', text: 'front1' },
    { name: 'tavern:runtime-preset-front', text: 'front2' },
    { name: 'tavern:dsh-system', text: 'system body' },
    { name: 'tavern:runtime-preset-back', text: 'back' }
  ] } }
  const before = JSON.stringify(message)
  const rows = sections({ messages: [message] })
  assert.deepEqual(Array.from(rows, r => r.title.split(' · ').at(-1)), ['预设前段', '消息正文', '预设后段'])
  assert.equal(rows.flatMap(r => Array.from(r.body)).join(''), message.content)
  assert.equal(new Set(rows.map(r => r.displayKey)).size, 3)
  assert.equal(JSON.stringify(message), before)
})
