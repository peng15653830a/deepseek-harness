import assert from 'node:assert/strict'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { appendSessionEvent, surfaceReplacementRange } from '../tavern-plugin/lib/domain/session-events.js'

test('host boundary preserves synthetic assistant messages and user replacement', { skip: !process.env.DSH_BOOT_MODULE }, async () => {
  const { Session } = await import(new URL('../../dsh-session/lib/index.js', pathToFileURL(process.env.DSH_BOOT_MODULE)))
  const session = Session.create('boundary-test')
  const message = (id, role, text) => ({ id, role, content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: 'dsh-tavern' } })
  const user = appendSessionEvent(session, 'user/message', message('u', 'user', 'before'), { surfaceOp: 'append' })
  const intent = { surfaceOp: { op: 'replace', start: user.seq, end: user.seq }, sourceEventSeqs: [user.seq] }
  const replacement = appendSessionEvent(session, 'user/message', message('u2', 'user', 'after'), intent)
  appendSessionEvent(session, 'assistant/message', { turn: 1, step: 1, message: message('a', 'assistant', 'opening') }, { surfaceOp: 'append', sourceEventSeqs: [] })
  assert.deepEqual(session.deriveMessages().map(m => m.content[0].text), ['after', 'opening'])
  assert.deepEqual(surfaceReplacementRange(replacement.surfaceOp), { start: user.seq, end: user.seq })
  assert.deepEqual(intent.surfaceOp, { op: 'replace', start: user.seq, end: user.seq })
})
