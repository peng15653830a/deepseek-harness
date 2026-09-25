import test from 'node:test'
import assert from 'node:assert/strict'
import { foregroundWorldbookReads } from '../tavern-plugin/lib/domain/worldbook-read-handoff.js'
const read = (turn, id, entries, args = { refs: entries.map(e => e.ref) }, isError = false) => [
  { type: 'assistant/message', data: { turn, message: { content: [{ type: 'tool-call', name: 'worldbook_search', id, arguments: JSON.stringify(args) }] } } },
  { type: 'tool/result', data: { turn, message: { content: [{ type: 'tool-result', toolCallId: id, isError, content: [{ type: 'text', text: JSON.stringify({ mode: args.query ? 'search' : 'read', entries }) }] }] } } }
]
const entry = (ref, text) => ({ ref, title: ref, text, status: 'ok' })
test('only successful full reads from the committed turn are handed off; latest read wins', () => {
  const events = [
    ...read(1, 'old', [entry('old', '旧轮次')]),
    ...read(2, 'search', [entry('snippet', '搜索片段')], { query: '少林' }),
    ...read(2, 'first', [entry('62', '旧内容')]),
    ...read(2, 'second', [entry('62', '完整正文'), { ...entry('failed', '失败正文'), status: 'render-error' }, entry('empty', '')]),
    ...read(2, 'error', [entry('error', '错误结果')], undefined, true),
    ...read(3, 'future', [entry('future', '未提交轮次')])
  ]
  const session = { snapshotEvents: () => events }, chat = { messages: [{ role: 'assistant', turn: 2 }] }
  const before = JSON.stringify(events)
  const text = foregroundWorldbookReads(chat, session)
  assert.match(text, /完整正文/)
  for (const excluded of ['旧轮次', '搜索片段', '旧内容', '失败正文', '错误结果', '未提交轮次']) assert.ok(!text.includes(excluded))
  assert.equal(JSON.parse(text.split('\n').at(-1)).entries.length, 1)
  assert.equal(JSON.stringify(events), before)
  assert.equal(foregroundWorldbookReads({ messages: [{ role: 'assistant', turn: 1, greeting: true }] }, session), '')
})
test('rollback, regeneration and missing sessions never reuse another turn or background reads', () => {
  const session = { events: [...read(2, 'original', [entry('62', '旧正文')]), ...read(7, 'regenerated', [entry('62', '重生成正文')])] }
  assert.match(foregroundWorldbookReads({ messages: [{ role: 'assistant', turn: 2 }], regeneratedDshTurns: { 2: 7 } }, session), /重生成正文/)
  assert.equal(foregroundWorldbookReads({ messages: [{ role: 'assistant', turn: 1 }] }, session), '')
  assert.equal(foregroundWorldbookReads({ messages: [{ role: 'assistant', turn: 2 }] }, undefined), '')
})
test('unpaired, malformed and non-worldbook tool results are not transferred', () => {
  const events = read(2, 'call', [entry('62', '正文')])
  events[0].data.message.content[0].name = 'another_tool'
  assert.equal(foregroundWorldbookReads({ messages: [{ role: 'assistant', turn: 2 }] }, { events }), '')
  events[0].data.message.content[0].name = 'worldbook_search'
  events[0].data.message.content[0].arguments = '{broken'
  assert.equal(foregroundWorldbookReads({ messages: [{ role: 'assistant', turn: 2 }] }, { events }), '')
})
