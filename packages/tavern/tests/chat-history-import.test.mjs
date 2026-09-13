import test from 'node:test'
import assert from 'node:assert/strict'
import { parseChatHistory, CHAT_IMPORT_MAX_BYTES } from '../tavern-plugin/lib/domain/chat-history-import.js'
const encode = (...messages) => [JSON.stringify({ chat_metadata: {} }), ...messages.map(m => JSON.stringify(m))].join('\n')
const state = n => ({ stat_data: { world: { day: n } }, schema: '{}' })

test('selected swipe state is paired with mes; alternatives and reasoning are discarded', () => {
  const parsed = parseChatHistory('\uFEFF' + encode({ is_user: false, mes: 'selected', swipe_id: 1,
    swipes: ['discarded secret', 'selected'], variables: [state(1), state(2)], extra: { reasoning: 'hidden secret' } }))
  assert.equal(parsed.messages[0].variables.stat_data.world.day, 2)
  assert.equal(parsed.messages[0].sourceSwipe, 1)
  assert.doesNotMatch(JSON.stringify(parsed), /secret/)
})
test('missing states inherit only preceding selected state and record provenance', () => {
  const parsed = parseChatHistory(encode({ is_user: false, mes: 'opening' },
    { is_user: true, mes: 'go', variables: [state(3)] }, { is_user: false, mes: 'reply', variables: [{}] }))
  assert.equal(parsed.messages[0].variables, undefined)
  assert.equal(parsed.messages[2].variables.stat_data.world.day, 3)
  assert.equal(parsed.messages[2].stateSourceLine, 3)
  assert.equal(parsed.messages[2].stateInherited, true)
})
test('format failures have line numbers and do not select a different variable slot', () => {
  assert.throws(() => parseChatHistory('{}\n'), /头部/)
  assert.throws(() => parseChatHistory('{"chat_metadata":{}}\nBAD'), /第 2 行/)
  assert.throws(() => parseChatHistory(encode({ is_user: false, mes: 'x', swipe_id: -1 })), /编号/)
  const parsed = parseChatHistory(encode({ is_user: false, mes: 'x', swipe_id: 1, variables: [state(8)] }))
  assert.equal(parsed.hasMvu, false)
  assert.throws(() => parseChatHistory('x'.repeat(CHAT_IMPORT_MAX_BYTES + 1)), /8 MB/)
})
test('system notes are excluded and user-ending exports remain ordered', () => {
  const parsed = parseChatHistory(encode({ is_system: true, mes: 'note' }, { is_user: true, mes: 'one' }, { is_user: true, mes: 'two' }) + '\n\n')
  assert.deepEqual(parsed.messages.map(m => m.text), ['one', 'two'])
  assert.ok(parsed.warnings.some(w => /跳过 1 条/.test(w)))
  assert.ok(parsed.warnings.some(w => /连续同角色/.test(w)))
})
