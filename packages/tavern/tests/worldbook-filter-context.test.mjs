import test from 'node:test'
import assert from 'node:assert/strict'
import { Session } from './fixtures/dsh-session-host.mjs'
import { sessionEvents, appendSessionEvent } from '../tavern-plugin/lib/domain/session-events.js'
import { replaceSessionSurface } from '../tavern-plugin/lib/domain/session-surface-mutations.js'
import { projectWorldbookFilterContext } from '../tavern-plugin/lib/domain/worldbook-filter-context.js'

const input = candidates => ({ task: 'worldbook-filter', messages: [{ role: 'user', content: [{ type: 'text', text: JSON.stringify({ currentInput: '当前输入', recent: [], candidates }) }] }] })
const candidate = (ref = 'entry:1', text = 'x'.repeat(15000)) => ({ ref, text, hits: [{ key: '当前关键词' }] })
const items = result => JSON.parse(result.payloadText).candidates
function append(session, projected, id = 'first') {
  const lead = '【最近剧情与本次任务】\n[用户]\n'
  return appendSessionEvent(session, 'user/message', { id, role: 'user',
    content: [{ type: 'text', text: lead + projected.payloadText + '\n任务协议' }],
    source: { kind: 'plugin', plugin: 'dsh-tavern', worldbookFilterPayload: { version: 1, start: lead.length, length: projected.payloadText.length } }
  }, { surfaceOp: 'append' })
}

test('unchanged bodies are referenced; changed bodies and refs are resent, without modifying history', () => {
  const session = Session.create('delta')
  const first = projectWorldbookFilterContext(session, input([candidate()]))
  assert.equal(items(first)[0].text.length, 15000)
  append(session, first)
  const before = JSON.stringify(sessionEvents(session))
  const next = projectWorldbookFilterContext(session, input([candidate(), candidate('entry:2'), candidate('entry:1', 'changed')]))
  assert.equal(items(next)[0].text, undefined)
  assert.equal(items(next)[0].bodyReference.messageId, 'first')
  assert.equal(items(next)[1].text.length, 15000, 'same content under another ref is not silently aliased')
  assert.equal(items(next)[2].text, 'changed')
  assert.equal(JSON.stringify(sessionEvents(session)), before)
})

test('restart reconstructs from current surface; compaction cannot reuse raw archived bodies', () => {
  let session = Session.create('restart')
  const event = append(session, projectWorldbookFilterContext(session, input([candidate()])))
  session = Session.create(session.id, sessionEvents(session), session.header)
  assert.ok(items(projectWorldbookFilterContext(session, input([candidate()])))[0].bodyReference)
  replaceSessionSurface(session, 'user/message', { id: 'summary', role: 'user', content: [{ type: 'text', text: '压缩摘要，没有全文' }], source: { kind: 'plugin', plugin: 'compaction' } },
    { start: event.seq, end: event.seq, sourceEventSeqs: [event.seq] })
  assert.equal(items(projectWorldbookFilterContext(session, input([candidate()])))[0].text.length, 15000)
})

test('a surviving reference is not proof when its source body was removed', () => {
  const session = Session.create('references')
  const first = append(session, projectWorldbookFilterContext(session, input([candidate()])))
  append(session, projectWorldbookFilterContext(session, input([candidate()])), 'reference-only')
  replaceSessionSurface(session, 'user/message', { id: 'empty', role: 'user', content: [], source: { kind: 'plugin', plugin: 'compaction' } },
    { start: first.seq, end: first.seq, sourceEventSeqs: [first.seq] })
  assert.equal(items(projectWorldbookFilterContext(session, input([candidate()])))[0].text.length, 15000)
})

test('only current candidates remain eligible and current match metadata is preserved', () => {
  const session = Session.create('eligible')
  append(session, projectWorldbookFilterContext(session, input([candidate('old'), candidate('new')])))
  const current = { ...candidate('new'), hits: [{ key: '本轮新触发词' }] }
  const next = items(projectWorldbookFilterContext(session, input([current])))
  assert.deepEqual(next.map(c => c.ref), ['new'])
  assert.deepEqual(next[0].hits, current.hits)
  assert.ok(next[0].bodyReference)
})

test('missing or altered projection evidence falls back to full bodies', () => {
  const session = Session.create('tampered')
  append(session, projectWorldbookFilterContext(session, input([candidate()])))
  const message = structuredClone(session.deriveMessages()[0])
  message.content[0].text = message.content[0].text.replace('x'.repeat(15000), 'y'.repeat(15000))
  assert.equal(items(projectWorldbookFilterContext({ deriveMessages: () => [message] }, input([candidate()])))[0].text.length, 15000)
  for (const unavailable of [{}, { deriveMessages() { throw new Error('unavailable') } }]) {
    assert.equal(items(projectWorldbookFilterContext(unavailable, input([candidate()])))[0].text.length, 15000)
  }
})

test('other task kinds are not projected', () => {
  assert.equal(projectWorldbookFilterContext(null, { ...input([candidate()]), task: 'candidate' }), null)
})


test('short bodies stay literal rather than growing into larger references', () => {
  const session = Session.create('short')
  const entry = candidate('short', '很短的资料')
  append(session, projectWorldbookFilterContext(session, input([entry])))
  assert.deepEqual(items(projectWorldbookFilterContext(session, input([entry]))), [entry])
})
