import { zipText } from './fixtures/zip-text.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { createSceneImageDiagnostics, redactSceneDiagnostic } from '../tavern-plugin/lib/domain/scene-image-diagnostics.js'
import { createMvuDiagnosticStore, createMvuDiagnosticExport } from '../tavern-plugin/lib/domain/mvu-diagnostics.js'
import { generateSceneImage } from '../tavern-plugin/lib/domain/scene-image-provider.js'

function storage() {
  const values = new Map()
  return { values, async readJson(path) { return structuredClone(values.get(path)) }, async updateJson(path, update) { const value = await update(values.get(path)); values.set(path, structuredClone(value)); return value } }
}
const attempt = (n, stage = 'planning', status = 'running') => ({ requestId: 'request-' + n, targetKey: 'body-' + n, sessionId: 'parent', stage, status, createdAt: Date.now() - 10, details: { prompt: '画面' } })
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKfoAAAAASUVORK5CYII=', 'base64')

test('host diagnostics summarize terminal attempts without prompts, headers or image bytes', async () => {
  const lines = [], disk = storage()
  const logs = createSceneImageDiagnostics(disk, { onDiagnostic: event => lines.push(event) })
  const value = { ...attempt(1, 'generating', 'failed'), outcome: 'unconfirmed', details: {
    configuration: { provider: 'novelai', baseURL: 'https://image.novelai.net', model: 'nai-diffusion-5-full', apiKey: 'private-key', size: '832x1216' },
    prompt: 'private-story', plan: { private: 'private-plan' },
    providerRequests: [{ phase: 'transport-error', method: 'POST', durationMs: 20, networkCodes: ['ECONNRESET'], error: 'private-error', body: 'private-body' }]
  } }
  await logs.record('chat', value, ['private-key'])
  assert.equal(lines.length, 1)
  assert.equal(lines[0].kind, 'generation')
  assert.equal(lines[0].provider, 'novelai')
  assert.deepEqual(lines[0].requests[0].networkCodes, ['ECONNRESET'])
  assert.doesNotMatch(JSON.stringify(lines), /private-/)
  const throwing = createSceneImageDiagnostics(disk, { onDiagnostic: () => { throw new Error('logger') } })
  await throwing.record('chat', value)
  assert.equal((await throwing.read('chat')).records.length, 1)
})

test('generation request diagnostics retain bounded AggregateError cause codes', async () => {
  const events = []
  const cause = new AggregateError([
    Object.assign(new Error('sensitive network details'), { code: 'ECONNREFUSED' }),
    Object.assign(new Error('certificate'), { code: 'CERT_HAS_EXPIRED' }),
    Object.assign(new Error('unrecognized'), { code: 'arbitrary-secret' })
  ])
  await assert.rejects(generateSceneImage({ provider: 'novelai', baseURL: 'https://image.novelai.net',
    model: 'nai-diffusion-5-full', size: '832x1216', prompt: 'A lake', apiKey: 'test-key',
    signal: new AbortController().signal, onProviderRequest: event => events.push(event)
  }, { fetch: async () => { throw new TypeError('fetch failed', { cause }) } }), /fetch failed/)
  const failure = events.find(event => event.phase === 'transport-error')
  assert.deepEqual(failure.networkCodes, ['ECONNREFUSED', 'CERT_HAS_EXPIRED'])
  assert.doesNotMatch(JSON.stringify(failure), /sensitive network details|arbitrary-secret/)
})

test('attempt journal replaces snapshots without losing older attempts or stage events and survives a new reader', async () => {
  const disk = storage(), logs = createSceneImageDiagnostics(disk)
  const first = attempt(1)
  await logs.record('chat', first)
  await logs.record('chat', { ...first, stage: 'generating' })
  await logs.record('chat', { ...first, stage: 'generating', status: 'failed', error: 'unconfirmed' })
  await logs.record('chat', attempt(2, 'completed', 'succeeded'))
  const result = await createSceneImageDiagnostics(disk).read('chat')
  assert.equal(result.records.length, 2)
  assert.deepEqual(result.records[0].events.map(event => event.stage), ['planning', 'generating', 'generating'])
  assert.ok(result.records[0].stageDurationsMs.planning >= 0)
  assert.ok(result.records[0].durationMs >= 0)
  assert.equal(result.records[0].error, 'unconfirmed')
  assert.equal((await logs.read('other')).records.length, 0)
})

test('diagnostics redact known secrets, credentials, signed URLs and image bytes before persistence', async () => {
  const disk = storage(), logs = createSceneImageDiagnostics(disk)
  const value = { ...attempt(1), details: { apiKey: 'key-content', prompt: 'plain known-token-value', nested: { password: 'pass-content' },
    address: 'https://user:password@host/image?signature=signed-query', headers: { authorization: 'Bearer auth-content' },
    picture: Buffer.from('IMAGE-BYTES'), base64: 'IMAGE-BASE64', uri: 'data:image/png;base64,OTHER-BYTES' } }
  await logs.record('chat', value, ['known-token-value'])
  const text = JSON.stringify([...disk.values.values()])
  for (const word of ['key-content', 'known-token-value', 'pass-content', 'signed-query', 'auth-content', 'IMAGE-BYTES', 'IMAGE-BASE64', 'OTHER-BYTES']) assert.ok(!text.includes(word), word)
  assert.match(text, /REDACTED/)
  assert.equal(redactSceneDiagnostic(new Uint8Array([1, 2])), '[image bytes omitted]')
})

test('journal bounds attempts and oversized workflows with explicit omissions', async () => {
  const disk = storage(), logs = createSceneImageDiagnostics(disk)
  await logs.record('chat', { ...attempt(0), details: { workflow: 'x'.repeat(200000) } })
  assert.equal((await logs.read('chat')).records[0].truncated, true)
  for (let n = 1; n <= 105; n++) await logs.record('chat', attempt(n))
  const result = await logs.read('chat')
  assert.equal(result.records.length, 100)
  assert.equal(result.dropped, 6)
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 2 * 1024 * 1024)
})

test('same log ZIP contains scene attempts and their native subagent without reading generated images', async () => {
  const disk = storage(), logs = createSceneImageDiagnostics(disk)
  await logs.record('chat', { ...attempt(1, 'completed', 'succeeded'), traceSessionId: 'image-child', details: { attachment: { attachmentId: 'generated' }, prompt: '雨中车站' } })
  const read = []
  const result = await createMvuDiagnosticExport({ sessionId: 'parent', store: createMvuDiagnosticStore(disk), sceneDiagnostics: await logs.read('chat'),
    persistence: { async readRaw(id) { read.push(id); return { content: JSON.stringify({ type: 'session', id }) } } },
    attachments: { readImage() { assert.fail('scene image bytes must not be included') } } })
  assert.deepEqual(read, ['parent', 'image-child'])
  const text = zipText(result.buffer)
  assert.match(text, /scene-images\/diagnostics.json/)
  assert.match(text, /subagents\/image-child\/session.jsonl/)
  assert.match(text, /雨中车站/)
  assert.match(text, /分享前请检查隐私/)
})

test('provider observers report actual POST, download, IDs and timing but no auth or pixels; failures do not retry', async () => {
  const events = [], calls = []
  const input = { baseURL: 'https://host/v1', model: 'example', apiKey: 'plain-secret-key', prompt: 'single scene', onProviderRequest: async event => events.push(event) }
  await generateSceneImage(input, { validateDownload: async address => address, fetch: async (url, init) => {
    calls.push({ url, init })
    return init?.method === 'POST' ? Response.json({ data: [{ url: 'https://host/picture?signature=private-link' }] }, { headers: { 'x-request-id': 'remote-id' } }) : new Response(png)
  } })
  assert.equal(calls.length, 2)
  assert.deepEqual(events.map(event => event.phase), ['dispatch', 'response', 'dispatch', 'response'])
  assert.equal(events[0].body.prompt, 'single scene')
  assert.equal(events[1].providerRequestId, 'remote-id')
  assert.ok(events[1].durationMs >= 0)
  assert.doesNotMatch(JSON.stringify(events), /plain-secret-key|private-link|iVBORw/)
  let requests = 0
  await assert.rejects(generateSceneImage({ ...input, onProviderRequest() { throw Error('diagnostic disk full') } }, { fetch: async () => { requests++; return new Response('', { status: 503 }) } }), error => error.imageOutcome === 'unconfirmed')
  assert.equal(requests, 1)
})

test('progress writes only the active attempt and a small index, while reading preserves the public log', async () => {
  const disk = storage(), logs = createSceneImageDiagnostics(disk)
  for (let n = 0; n < 50; n++) await logs.record('chat', { ...attempt(n), details: { prompt: 'x'.repeat(10000) } })
  let transferred = 0
  const update = disk.updateJson
  disk.updateJson = async (path, updater) => {
    transferred += Buffer.byteLength(JSON.stringify(disk.values.get(path) || null))
    const result = await update(path, updater)
    transferred += Buffer.byteLength(JSON.stringify(result || null))
    return result
  }
  for (let n = 0; n < 20; n++) await logs.record('chat', { ...attempt(49, 'step-' + n), details: { prompt: 'x'.repeat(10000) } })
  assert.ok(transferred < 2000000, 'progress must not rewrite all 50 attempt bodies: ' + transferred)
  const result = await createSceneImageDiagnostics(disk).read('chat')
  assert.equal(result.version, 1)
  assert.equal(result.records.length, 50)
  assert.equal(result.records.at(-1).events.length, 21)
  assert.equal(result.records[0].details.prompt.length, 10000)
})

test('legacy logs remain readable when migration publication fails, then migrate without losing history', async () => {
  const { createHash } = await import('node:crypto')
  const disk = storage()
  const path = 'diagnostics/scene-' + createHash('sha256').update('chat').digest('hex') + '.json'
  const legacy = { version: 1, chatId: 'chat', dropped: 3, records: [{ ...attempt(1), events: [{ at: 1, stage: 'planning', status: 'running' }] }] }
  disk.values.set(path, structuredClone(legacy))
  const logs = createSceneImageDiagnostics(disk)
  assert.deepEqual(await logs.read('chat'), legacy)
  const update = disk.updateJson
  let fail = true
  disk.updateJson = async (file, updater) => {
    if (file === path && fail) { await updater(structuredClone(disk.values.get(file))); throw new Error('index failure') }
    return update(file, updater)
  }
  await assert.rejects(logs.record('chat', attempt(2)), /index failure/)
  assert.deepEqual(await logs.read('chat'), legacy)
  fail = false
  await logs.record('chat', attempt(2))
  const restored = await createSceneImageDiagnostics(disk).read('chat')
  assert.equal(restored.dropped, 3)
  assert.deepEqual(restored.records[0], legacy.records[0])
  assert.equal(restored.records[1].requestId, 'request-2')
  assert.equal(disk.values.get(path).version, 2)
})

test('retention removes evicted detail files and retries failed cleanup without losing live attempts', async () => {
  const disk = storage(), logs = createSceneImageDiagnostics(disk)
  let failRemoval = true
  disk.remove = async path => { if (failRemoval) throw Error('busy'); disk.values.delete(path) }
  for (let n = 0; n < 25; n++) await logs.record('chat', { ...attempt(n), details: { prompt: 'x'.repeat(100000) } })
  const before = await logs.read('chat')
  assert.ok(before.dropped > 0)
  assert.ok(Buffer.byteLength(JSON.stringify(before)) < 2 * 1024 * 1024)
  const evicted = 0
  // Reintroduce an evicted identity while failed removals remain pending.
  await logs.record('chat', attempt(evicted, 'revived'))
  failRemoval = false
  await logs.record('chat', attempt(24, 'latest'))
  const result = await logs.read('chat')
  assert.equal(result.records.find(row => row.requestId === 'request-0').stage, 'revived')
  assert.equal(disk.values.size, result.records.length + 1)
  assert.ok(result.records.every(row => !row.unavailable))
})

test('two diagnostic writers serialize updates through the durable index and preserve per-attempt events', async t => {
  const { createProfileDataStore } = await import('../tavern-plugin/lib/profile-data-store.js')
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = await mkdtemp(join(tmpdir(), 'scene-diag-concurrent-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const disk = createProfileDataStore({ dataRoot: root })
  const first = createSceneImageDiagnostics(disk), second = createSceneImageDiagnostics(disk)
  await Promise.all(Array.from({ length: 12 }, (_, n) => (n % 2 ? first : second).record('chat', attempt(1, 'phase-' + n))))
  const read = await second.read('chat')
  assert.equal(read.records.length, 1)
  assert.equal(read.records[0].events.length, 12)
  assert.equal(new Set(read.records[0].events.map(event => event.stage)).size, 12)
  await second.record('chat', { ...attempt(1), targetKey: 'other-target' })
  assert.equal((await first.read('chat')).records.length, 2)
})

test('failed detail writes leave existing logs readable; missing files are explicit in exports', async () => {
  const disk = storage(), logs = createSceneImageDiagnostics(disk)
  await logs.record('chat', attempt(1))
  const before = await logs.read('chat')
  const update = disk.updateJson
  disk.updateJson = async (path, updater) => {
    if (path.split('/').length === 3) throw new Error('detail write failed')
    return update(path, updater)
  }
  await assert.rejects(logs.record('chat', attempt(1, 'generating')), /detail write failed/)
  assert.deepEqual(await logs.read('chat'), before)
  disk.updateJson = update
  await logs.record('chat', attempt(1, 'generating'))
  assert.deepEqual((await logs.read('chat')).records[0].events.map(row => row.stage), ['planning', 'generating'])
  for (const path of disk.values.keys()) if (path.split('/').length === 3) disk.values.delete(path)
  const missing = (await logs.read('chat')).records[0]
  assert.equal(missing.unavailable, true)
  assert.equal(missing.requestId, 'request-1')
})
