import test from 'node:test'
import assert from 'node:assert/strict'
import { projectCompactionRequest, installCompactionRequestProjection } from '../tavern-plugin/lib/domain/compaction-request.js'

const empty = plugin => Object.freeze({ role: 'user', content: Object.freeze([]), source: Object.freeze({ kind: 'plugin', plugin }) })
const metadata = empty('dsh-tavern')

test('only removes Tavern metadata placeholders; preserves valid request prefix and envelope', () => {
  const story = Object.freeze({ role: 'user', content: [{ type: 'text', text: '故事' }], source: { kind: 'user' } })
  const image = Object.freeze({ role: 'user', content: [{ type: 'image', url: 'fixture' }] })
  const tool = Object.freeze({ role: 'assistant', content: [{ type: 'tool-call', id: 'call' }] })
  const unknown = empty('another-plugin')
  const instruction = Object.freeze({ role: 'user', content: [{ type: 'text', text: '摘要指令' }], source: { plugin: 'dsh-compaction-basic' } })
  const kept = [story, image, tool, unknown, instruction]
  const messages = Object.freeze([metadata, story, empty('dsh-tavern-failed-turn-cleanup'), image, tool, unknown, metadata, instruction])
  const request = Object.freeze({ purpose: 'compaction', sessionId: 's', system: '固定系统前缀', tools: Object.freeze([{ name: 'fixture' }]), provider: 'fixture', model: 'text', maxTokens: 1024, signal: new AbortController().signal, messages })
  const projected = projectCompactionRequest(request)
  assert.deepEqual(projected.messages, kept)
  projected.messages.forEach((message, i) => assert.equal(message, kept[i]))
  for (const key of Object.keys(request).filter(k => k !== 'messages')) assert.equal(projected[key], request[key])
  assert.equal(request.messages, messages)
  assert.equal(projectCompactionRequest(projected), projected, 'projection is idempotent')
})

test('ordinary requests and summaries without placeholders retain object identity', () => {
  for (const request of [undefined, {}, { messages: [metadata] }, { purpose: 'compaction', messages: [] }]) {
    assert.equal(projectCompactionRequest(request), request)
  }
})

test('middleware forwards only owned compaction requests and terminates redispatch', async () => {
  let handler, lookups = 0, forwarded = 0, fallback = 0
  const ctx = { on: (_event, callback) => { handler = callback }, llm: { stream: request => { forwarded++; return handler(request, next) } } }
  async function *next() { fallback++; yield 'result' }
  installCompactionRequestProjection(ctx, async id => { lookups++; return id === 'owned' })
  for (const request of [
    { purpose: 'compaction', sessionId: 'owned', messages: [metadata] },
    { purpose: 'compaction', sessionId: 'other', messages: [metadata] },
    { sessionId: 'owned', messages: [metadata] }
  ]) {
    const result = []
    for await (const chunk of handler(request, next)) result.push(chunk)
    assert.deepEqual(result, ['result'])
  }
  assert.equal(lookups, 2)
  assert.equal(forwarded, 1)
  assert.equal(fallback, 3)
})
