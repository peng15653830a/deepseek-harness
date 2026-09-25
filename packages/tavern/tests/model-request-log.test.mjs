import assert from 'node:assert/strict'
import test from 'node:test'

import { createModelRequestLog } from '../tavern-plugin/lib/domain/model-request-log.js'

function presetMessage(phase, text) {
  return {
    role: 'system',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'dsh-tavern', sections: [{ name: 'tavern:runtime-preset-' + phase, text }] }
  }
}

test('逐次保存前后台真实请求，并可按游玩轮次完整读取', async () => {
  const files = new Map()
  const log = createModelRequestLog({
    readJson: async function (path) { return structuredClone(files.get(path)) },
    writeJson: async function (path, value) { files.set(path, structuredClone(value)) },
    updateJson: async function (path, updater) {
      const next = await updater(structuredClone(files.get(path)))
      files.set(path, structuredClone(next))
      return structuredClone(next)
    },
    now: function () { return 1000 },
    id: (function () { let value = 0; return function () { value += 1; return 'request-' + value } })()
  })
  const chat = { id: 'chat-1', requestMode: 'sillytavern', runtimePresetPath: 'presets/demo.json', runtimePresetSnapshot: { digest: 'digest-1' } }
  const longText = '原'.repeat(13000)
  const foreground = await log.record({
    chat,
    context: null,
    coordinates: {
      turn: 2,
      step: 1,
      frame: { frameId: 'foreground:chat-1:branch-1:operation-1', basedOnRevision: 3, append: { appended: true } }
    },
    options: {
      provider: 'test', model: 'scripted', sessionId: 'foreground-1', signal: new AbortController().signal,
      system: '系统提示', tools: [{ name: 'tool-a' }],
      messages: [presetMessage('front', '前'), { role: 'user', content: [{ type: 'text', text: longText }] }, presetMessage('middle', '中'), presetMessage('back', '后')]
    }
  })
  await log.complete({ chatId: 'chat-1', id: foreground.id, text: '完整模型结果', finish: { kind: 'stop' } })
  await log.record({
    chat,
    context: { scope: 'background', task: 'candidate', turn: 2 },
    coordinates: { turn: 7, step: 2 },
    options: { provider: 'test', model: 'scripted', sessionId: 'background-1', messages: [{ role: 'user', content: [{ type: 'text', text: '候选任务' }] }] }
  })

  const evidence = await log.evidence('chat-1', 2)
  assert.equal(evidence.requests.length, 2)
  assert.deepEqual(evidence.requests.map(function (item) { return [item.scope, item.task, item.turn, item.agentTurn, item.step] }), [
    ['foreground', 'reply', 2, 2, 1],
    ['background', 'candidate', 2, 7, 2]
  ])
  assert.equal(evidence.requests[0].request.messages[1].content[0].text.length, 13000)
  assert.equal(Object.prototype.hasOwnProperty.call(evidence.requests[0].request, 'signal'), false)
  assert.equal(evidence.requests[0].requestMode, 'sillytavern')
  assert.equal(evidence.requests[0].frame.frameId, 'foreground:chat-1:branch-1:operation-1')
  assert.equal(evidence.requests[0].frame.append.appended, true)
  assert.equal(evidence.requests[0].status, 'completed')
  assert.equal(evidence.requests[0].response.text, '完整模型结果')
  assert.deepEqual(['front', 'middle', 'back'].map(function (phase) { return evidence.requests[0].phases[phase][0].content[0].text }), ['前', '中', '后'])
  assert.equal((await log.evidence('chat-1', 3)).requests.length, 0)
})

function storageFixture() {
  const files = new Map()
  const operations = []
  let stamp = 1000
  const adapters = {
    readJson: async path => {
      operations.push(['read', path])
      return structuredClone(files.get(path))
    },
    writeJson: async (path, value) => {
      operations.push(['write', path])
      files.set(path, structuredClone(value))
    },
    updateJson: async (path, updater) => {
      files.set(path, structuredClone(await updater(structuredClone(files.get(path)))))
    },
    now: () => stamp,
    id: () => 'fixture'
  }
  return { files, operations, adapters, advance: () => { stamp += 250 } }
}

test('完成请求不再读写正文，阶段消息不重复存储，重启后完整还原', async () => {
  const fixture = storageFixture()
  const log = createModelRequestLog(fixture.adapters)
  const options = { system: '固定前缀', tools: [{ name: 'test' }], messages: [presetMessage('front', 'x'.repeat(1000000))] }
  const original = structuredClone(options)
  const record = await log.record({ chat: { id: 'chat' }, options })
  const path = 'model-requests/chat/' + record.id + '.json'
  const stored = structuredClone(fixture.files.get(path))
  assert.equal(stored.phases, undefined)
  fixture.operations.length = 0
  fixture.advance()
  const restarted = createModelRequestLog(fixture.adapters)
  await restarted.complete({ chatId: 'chat', id: record.id, text: '结果', finish: { kind: 'stop' } })
  assert.equal(fixture.operations.some(([, p]) => p === path), false)
  assert.deepEqual(fixture.files.get(path), stored)
  assert.deepEqual(options, original)
  const evidence = await restarted.evidence('chat')
  assert.deepEqual(evidence.requests[0].request, original)
  assert.deepEqual(evidence.requests[0].phases.front, original.messages)
  assert.equal(evidence.requests[0].durationMs, 250)
  assert.equal(evidence.requests[0].response.text, '结果')
})

test('兼容旧日志及未完成请求，失败结果可重试保存', async () => {
  const fixture = storageFixture()
  const legacy = { version: 1, id: 'old', createdAt: 900, status: 'running', phases: { front: [] }, request: { messages: [] } }
  fixture.files.set('model-requests/chat/old.json', legacy)
  fixture.files.set('model-requests/chat/index.json', { requests: [{ id: 'old' }] })
  const log = createModelRequestLog(fixture.adapters)
  assert.deepEqual((await log.evidence('chat')).requests[0], legacy)
  await log.complete({ chatId: 'chat', id: 'old', error: '失败' })
  const completed = (await log.evidence('chat')).requests[0]
  assert.equal(completed.status, 'failed')
  assert.equal(completed.durationMs, 100)
  assert.equal(completed.response.error, '失败')
  assert.equal(await log.complete({ chatId: 'chat', id: 'missing' }), null)

  const running = await log.record({ chat: { id: 'chat' }, options: { messages: [] } })
  assert.equal((await log.evidence('chat')).requests[1].status, 'running')
  const failing = createModelRequestLog({ ...fixture.adapters, writeJson: async () => { throw new Error('disk failure') } })
  await assert.rejects(failing.complete({ chatId: 'chat', id: running.id, text: '保留结果' }), /disk failure/)
  assert.equal((await log.evidence('chat')).requests[1].status, 'running')
  await log.complete({ chatId: 'chat', id: running.id, text: '保留结果' })
  assert.equal((await log.evidence('chat')).requests[1].response.text, '保留结果')
})

test('并发请求的完成结果互不串写，缺少状态文件仍可查看正文', async () => {
  const fixture = storageFixture()
  let sequence = 0
  const log = createModelRequestLog({ ...fixture.adapters, id: () => String(++sequence) })
  const first = await log.record({ chat: { id: 'chat' }, options: { messages: [presetMessage('back', '一')] } })
  const second = await log.record({ chat: { id: 'chat' }, options: { messages: [presetMessage('front', '二')] } })
  await Promise.all([
    log.complete({ chatId: 'chat', id: second.id, text: '结果二' }),
    log.complete({ chatId: 'chat', id: first.id, text: '结果一' })
  ])
  assert.deepEqual((await log.evidence('chat')).requests.map(item => item.response.text), ['结果一', '结果二'])
  fixture.files.delete('model-requests/chat/' + first.id + '.result.json')
  const evidence = await log.evidence('chat')
  assert.equal(evidence.requests[0].status, 'running')
  assert.equal(evidence.requests[0].phases.back[0].content[0].text, '一')
  await log.complete({ chatId: 'chat', id: first.id, text: '恢复结果' })
  assert.equal((await log.evidence('chat')).requests[0].response.text, '恢复结果')
})

test('context browser lists metadata only and retrieves exact snapshots within the owning chat', async () => {
  const files = new Map(), reads = []
  const log = createModelRequestLog({
    readJson: async path => { reads.push(path); return structuredClone(files.get(path)) },
    writeJson: async (path, value) => files.set(path, structuredClone(value)),
    updateJson: async (path, fn) => files.set(path, fn(structuredClone(files.get(path))))
  })
  const options = { system: 'system', messages: [{ role: 'user', content: [{ type: 'text', text: '完整'.repeat(20000) }] }], tools: [{ name: 'test', parameters: { type: 'object' } }] }
  const original = structuredClone(options)
  const item = await log.record({ chat: { id: 'owner', mode: 'card' }, coordinates: { turn: 2, step: 3 }, options })
  assert.equal((await log.latest('owner')).id, item.id)
  reads.length = 0
  assert.deepEqual(await log.latest('owner', item.id), { unchanged: true, id: item.id })
  assert.deepEqual(reads, ['model-requests/owner/index.json'])
  await log.record({ chat: { id: 'owner' }, context: { scope: 'background', turn: 2 }, options: { messages: [] } })
  assert.equal((await log.latest('owner')).id, item.id)
  assert.equal(await log.latest('empty'), null)
  options.messages[0].content[0].text = 'changed later'
  reads.length = 0
  assert.equal((await log.list('owner')).length, 2)
  assert.deepEqual(reads, ['model-requests/owner/index.json'])
  assert.deepEqual((await log.detail('owner', item.id)).request, original)
  await assert.rejects(log.detail('other', item.id), /不存在/)
  await assert.rejects(log.detail('owner', '../private'), /不存在/)
})

test('latest context isolates foreground, background and image sessions and survives restart', async () => {
  const files = new Map(), reads = []
  const adapter = {
    readJson: async path => { reads.push(path); return structuredClone(files.get(path)) },
    writeJson: async (path, value) => files.set(path, structuredClone(value)),
    updateJson: async (path, fn) => files.set(path, fn(structuredClone(files.get(path))))
  }
  const log = createModelRequestLog(adapter)
  const records = []
  for (const task of ['reply', 'background', 'image']) {
    records.push(await log.record({ chat: { id: 'owner' }, context: task === 'reply' ? null : { scope: 'background', task },
      options: { sessionId: task, messages: [{ role: 'user', content: task }], tools: [{ name: task }] } }))
  }
  const restarted = createModelRequestLog(adapter)
  for (const record of records) {
    assert.deepEqual((await restarted.latestForSession(record.sessionId)).request, record.request)
    reads.length = 0
    assert.deepEqual(await restarted.latestForSession(record.sessionId, record.id), { unchanged: true, id: record.id })
    assert.equal(reads.some(path => path.endsWith(record.id + '.json')), false)
  }
  assert.equal(await restarted.latestForSession('unknown', '', 'owner'), null)
  files.delete('model-request-sessions/image.json')
  assert.equal((await restarted.latestForSession('image', '', 'owner')).id, records[2].id)
})

test('session ownership writes once under concurrent requests and reuses disk ownership after restart', async () => {
  const files = new Map(), ownerReads = [], ownerWrites = []
  let fail = false
  const adapter = {
    readJson: async path => { if (path.startsWith('model-request-sessions/')) ownerReads.push(path); return structuredClone(files.get(path)) },
    writeJson: async (path, value) => {
      if (path.startsWith('model-request-sessions/')) {
        ownerWrites.push(path)
        if (fail) { fail = false; throw new Error('disk failure') }
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      files.set(path, structuredClone(value))
    },
    updateJson: async (path, fn) => files.set(path, fn(structuredClone(files.get(path))))
  }
  let log = createModelRequestLog(adapter)
  const input = { chat: { id: 'owner' }, options: { sessionId: 'agent', messages: [] } }
  await Promise.all(Array.from({ length: 20 }, () => log.record(input)))
  assert.equal(ownerReads.length, 1)
  assert.equal(ownerWrites.length, 1)
  await log.record(input)
  assert.equal(ownerReads.length, 1)
  log = createModelRequestLog(adapter)
  await log.record(input)
  assert.equal(ownerReads.length, 2)
  assert.equal(ownerWrites.length, 1)
  fail = true
  const changed = { ...input, chat: { id: 'new-owner' } }
  await assert.rejects(log.record(changed), /disk failure/)
  await log.record(changed)
  assert.equal(files.get('model-request-sessions/agent.json').chatId, 'new-owner')
  assert.equal(ownerWrites.length, 3)
})

test('请求凭据脱敏不修改原请求或提示词内容', async () => {
  let stored
  const log = createModelRequestLog({ readJson: async () => undefined, writeJson: async (path, value) => { if (value.request) stored = value }, updateJson: async (_path, fn) => fn(undefined) })
  const options = { sessionId: 's', apiKey: 'secret-a', headers: new Headers({ Authorization: 'Bearer secret-b', 'X-Api-Key': 'secret-c', Accept: 'application/json' }), config: { access_token: 'secret-d' }, messages: [{ role: 'user', content: '不要改写 apiKey 这段文字' }] }
  await log.record({ chat: { id: 'chat' }, options })
  for (const secret of ['secret-a', 'secret-b', 'secret-c', 'secret-d']) assert.equal(JSON.stringify(stored).includes(secret), false)
  assert.equal(stored.request.headers.accept, 'application/json')
  assert.deepEqual(stored.request.messages, options.messages)
  assert.equal(options.apiKey, 'secret-a')
  assert.equal(options.headers.get('Authorization'), 'Bearer secret-b')
})
