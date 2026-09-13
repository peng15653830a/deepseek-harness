import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../tavern-plugin/lib/index.js', import.meta.url), 'utf8')
const section = source.slice(source.indexOf('  async function stopChatForDeletion'), source.indexOf('  async function exportConversation'))
function setup() {
  const events = []
  const deletedChatIds = new Set()
  const workers = new Map(['a', 'background'].map(id => [id, { cancel: () => events.push('cancel:' + id), whenIdle: async () => events.push('idle:' + id) }]))
  const api = new Function('readChat', 'str', 'storyTimeline', 'agentRegistry', 'cancelSettlement', 'conversationRegistry', 'deletedChatIds', section + '; return { deleteChats };')(
    async id => ({ id, sessionId: id }), String,
    { inspect: () => ({ participants: { worker: { sessionId: 'background' } } }) }, workers,
    async id => { events.push('settlement:' + id) },
    { remove: async id => { events.push('remove:' + id); if (id === 'bad') throw new Error('disk error') } }, deletedChatIds)
  return { ...api, events, deletedChatIds }
}
test('batch deletion stops foreground and background before removing, deduplicates, and continues after a failure', async () => {
  const api = setup()
  const result = await api.deleteChats(['a', 'bad', 'a', 'c'])
  assert.deepEqual(result.results, [{ chatId: 'a', ok: true }, { chatId: 'bad', ok: false, error: 'disk error' }, { chatId: 'c', ok: true }])
  assert.ok(api.events.indexOf('idle:a') < api.events.indexOf('remove:a'))
  assert.ok(api.events.indexOf('idle:background') < api.events.indexOf('remove:a'))
  assert.deepEqual([...api.deletedChatIds], ['a', 'c'])
})
test('preparation only stops work without deleting, invalid selection cannot delete anything', async () => {
  const api = setup()
  await api.deleteChats(['a'], true)
  assert.ok(!api.events.some(event => event.startsWith('remove:')))
  await assert.rejects(api.deleteChats(['a', '']), /有效/)
  assert.deepEqual(await api.deleteChats([]), { results: [] })
})
