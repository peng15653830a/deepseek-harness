import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture } from './fixtures/history-scan-session.mjs'
import { prepareTemplateHistory } from '../tavern-plugin/lib/domain/template-history.js'
test('大量已归档消息不反复扫描活动历史，并保持别名及重复文本的匹配顺序', () => {
  const { session, events } = fixture(1000)
  let reads = 0
  for (const event of events) { const content = event.data.content; Object.defineProperty(event.data, 'content', { get() { reads++; return content } }) }
  const before = { messages: [...Array.from({ length: 1000 }, () => ({ role: 'user', text: 'archived' })), ...events.map(e => ({ role: 'user', text: e.data.content[0].text }))] }
  reads = 0
  const after = { messages: before.messages.map(m => ({ ...m, text: m.text+'changed' })) }
  prepareTemplateHistory(session, before, after)
  assert.ok(reads <= 1100, `content reads: ${reads}`)
  assert.equal(after.messages[999].templateHistoryEdit, undefined)
  assert.equal(after.messages[1000].templateHistoryEdit.seq, 0)
  assert.equal(after.messages.at(-1).templateHistoryEdit.seq, 999)
  const aliases = { messages: [{ role: 'user', text: 'different', sourceText: 'text1', sessionText: 'text0' }, { role: 'user', text: 'text0' }, { role: 'user', text: 'text1' }] }
  const changed = { messages: aliases.messages.map(m => ({ ...m, text: 'changed' })) }
  prepareTemplateHistory(session, aliases, changed)
  assert.deepEqual(changed.messages.map(m => m.templateHistoryEdit?.seq), [0, undefined, 1])
})
