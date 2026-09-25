import test from 'node:test'
import assert from 'node:assert/strict'
import { Session } from './fixtures/dsh-session-host.mjs'
import { sessionEvents, appendSessionEvent } from '../tavern-plugin/lib/domain/session-events.js'
import { replaceSessionSurface } from '../tavern-plugin/lib/domain/session-surface-mutations.js'
import { projectCandidateScriptContext as project } from '../tavern-plugin/lib/domain/candidate-script-context.js'

function input(body = 'x'.repeat(15000), position = 1) {
  const heading = '【剧本候选参考 · 游标 ' + position + ' / 3】'
  const text = heading + '\n[chunk-' + position + ']\n' + body
  return { task: 'candidate', turnContext: '最新指导\n\n' + text,
    candidateScriptWindow: { text, heading, positions: [position] }, tools: [{ name: 'tavern_read_script' }] }
}
function append(session, result, id = 'first') {
  return appendSessionEvent(session, 'user/message', { id, role: 'user', content: [{ type: 'text', text: result.turnContext }],
    source: { kind: 'plugin', plugin: 'dsh-tavern', ...(result.body ? { candidateScriptWindow: {
      version: 1, start: result.turnContext.indexOf(result.body), length: result.body.length, digest: result.digest
    } } : {}) }
  }, { surfaceOp: 'append' })
}

test('相同窗口仅追加引用，当前状态保留，历史不变，变化全文补发', () => {
  const session = Session.create('script')
  const original = input()
  append(session, project(session, original))
  const before = JSON.stringify(sessionEvents(session))
  const next = project(session, { ...original, turnContext: '新指导\n\n' + original.candidateScriptWindow.text })
  assert.match(next.turnContext, /^新指导/)
  assert.match(next.turnContext, /tavern_read_script.*position.*1/)
  assert.doesNotMatch(next.turnContext, /x{100}/)
  assert.ok(Buffer.byteLength(next.turnContext) < 1000)
  assert.equal(JSON.stringify(sessionEvents(session)), before)
  assert.equal(original.turnContext, input().turnContext)
  assert.ok(project(session, input('y'.repeat(15000))).body)
  assert.ok(project(session, input(undefined, 2)).body)
})

test('重启依据当前投影恢复，压缩移除全文后不信任残留引用', () => {
  let session = Session.create('script-restart')
  const first = append(session, project(session, input()))
  session = Session.create(session.id, sessionEvents(session), session.header)
  const reference = project(session, input())
  assert.equal(reference.body, undefined)
  append(session, reference, 'reference')
  replaceSessionSurface(session, 'user/message', { id: 'summary', role: 'user', content: [{ type: 'text', text: '摘要' }] },
    { start: first.seq, end: first.seq, sourceEventSeqs: [first.seq] })
  assert.ok(project(session, input()).body)
})

test('不可用或被修改的投影发送全文，无工具和小正文不优化', () => {
  const session = Session.create('altered')
  append(session, project(session, input()))
  const message = structuredClone(session.deriveMessages()[0])
  message.content[0].text = message.content[0].text.replace('xxx', 'yyy')
  assert.ok(project({ deriveMessages: () => [message] }, input()).body)
  for (const unavailable of [{}, { deriveMessages() { throw new Error('unavailable') } }]) assert.ok(project(unavailable, input()).body)
  assert.equal(project(session, { ...input(), task: 'settlement' }), null)
  assert.equal(project(session, { ...input(), tools: [] }), null)
  assert.equal(project(session, input('短文')), null)
  assert.equal(project(session, { ...input(), turnContext: '不匹配' }), null)
})
