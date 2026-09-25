import test from 'node:test'
import assert from 'node:assert/strict'
import { Session } from './fixtures/dsh-session-host.mjs'
import { appendSessionEvent, sessionEvents } from '../tavern-plugin/lib/domain/session-events.js'
import { retireForegroundFrames } from '../tavern-plugin/lib/domain/foreground-frame-retirement.js'

test('旧指引退出真实宿主上下文，当前轮及剧情保留，原始事件可恢复', () => {
  const session = Session.create('frame-retirement')
  for (const turn of [1, 2, 3]) {
    session.append('user/message', { id: 'input-' + turn, role: 'user', content: [{ type: 'text', text: '玩家' + turn }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    session.append('user/message', { id: 'frame-' + turn, role: 'user', content: [{ type: 'text', text: '指引' + turn }], source: { kind: 'plugin', plugin: 'dsh-tavern', form: 'foreground-frame', trace: { turn } } }, { surfaceOp: 'append' })
    appendSessionEvent(session, 'assistant/message', { turn, step: 1, message: { id: 'body-' + turn, role: 'assistant', content: [{ type: 'text', text: '正文' + turn }], source: { kind: 'model', provider: 'test', model: 'test' } } }, { surfaceOp: 'append' })
  }
  const original = structuredClone(sessionEvents(session))
  assert.equal(retireForegroundFrames(session, { keepTurn: 3 }), 2)
  assert.equal(retireForegroundFrames(session, { keepTurn: 3 }), 0)
  const restored = Session.create(session.id, JSON.parse(JSON.stringify(sessionEvents(session))), session.header)
  const content = JSON.stringify(restored.deriveMessages().map(message => message.content))
  assert.doesNotMatch(content, /指引[12]/)
  assert.match(content, /指引3/)
  for (const turn of [1, 2, 3]) { assert.match(content, new RegExp('玩家' + turn)); assert.match(content, new RegExp('正文' + turn)) }
  assert.deepEqual(sessionEvents(session).slice(0, original.length), original)
  assert.equal(retireForegroundFrames(restored), 1)
  assert.doesNotMatch(JSON.stringify(restored.deriveMessages().map(message => message.content)), /指引/)
})

import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
const source = await readFile(new URL('../tavern-plugin/lib/index.js', import.meta.url), 'utf8')
const helper = source.slice(source.indexOf('  async function retireOldForegroundFrames('), source.indexOf('  autoCompaction = createAutoCompaction('))
function frames() {
  const session = Session.create('frame-entry')
  for (const turn of [1, 2]) session.append('user/message', { id: 'f-' + turn, role: 'user', content: [{ type: 'text', text: 'frame-' + turn }], source: { kind: 'plugin', plugin: 'dsh-tavern', form: 'foreground-frame', trace: { turn } } }, { surfaceOp: 'append' })
  return session
}

test('生产 pre-step 在自动压缩及生成之前清理旧指引，多步工具调用保留当前指引', async () => {
  const session = frames(), calls = []
  let hook
  const context = {
    checkedCompactionPressure: new WeakSet(), ctx: { on: (_name, fn) => { hook = fn } },
    retireForegroundFrames, sessionStore: { flush: async () => calls.push('flush') },
    backgroundAgentRunner: { requestContext: () => null },
    chatForSession: async () => ({ mode: 'story' }), pendingCompactionMessages: new WeakMap(),
    configureAgentCompaction: async () => ({ compactIfNeeded: async () => {
      const text = JSON.stringify(session.deriveMessages().map(message => message.content))
      assert.doesNotMatch(text, /frame-1/); assert.match(text, /frame-2/)
      calls.push('compact')
    } })
  }
  const start = source.indexOf("  ctx.on('agent/pre-step', async (payload, next) => {")
  vm.runInNewContext(helper + source.slice(start, source.indexOf("  ctx.on('agent/status'", start)), context)
  const agent = { session }
  for (const step of [1, 2]) await hook({ agent, turn: 2, step, messages: [] }, async () => calls.push('generate'))
  assert.deepEqual(calls, ['flush', 'compact', 'generate', 'compact', 'generate'])
})

test('生产手动压缩入口在摘要模型读取之前清理闲置会话的全部指引', async () => {
  const session = frames(), calls = []
  const start = source.indexOf('    async compact(id, side, options, signal) {')
  const method = source.slice(start, source.indexOf('\n  })', start))
  const context = {
    retireForegroundFrames, sessionStore: { flush: async () => calls.push('flush') },
    withCompactionSession: async (_id, work) => work({ session, phase: { kind: 'idle' } }),
    agentCompaction: async () => ({ compactNow: async () => {
      assert.doesNotMatch(JSON.stringify(session.deriveMessages().map(message => message.content)), /frame-/)
      calls.push('summary')
    } })
  }
  const entry = vm.runInNewContext(helper + '\n({' + method + '})', context)
  await entry.compact('front', 'foreground', {}, undefined)
  assert.deepEqual(calls, ['flush', 'summary'])
})

test('旧存档无 trace 的指引可清理，其他插件内容不受影响', () => {
  const session = Session.create('legacy-frames')
  for (const [id, plugin, form] of [['legacy', 'dsh-tavern', 'foreground-frame'], ['foreign', 'other', 'foreground-frame'], ['snapshot', 'dsh-tavern', 'snapshot']]) {
    session.append('user/message', { id, role: 'user', content: [{ type: 'text', text: id }], source: { kind: 'plugin', plugin, form } }, { surfaceOp: 'append' })
  }
  assert.equal(retireForegroundFrames(session, { keepTurn: 3 }), 1)
  const text = JSON.stringify(session.deriveMessages().map(message => message.content))
  assert.doesNotMatch(text, /legacy/)
  assert.match(text, /foreign/); assert.match(text, /snapshot/)
})
