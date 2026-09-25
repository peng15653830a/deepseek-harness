import test from 'node:test'
import assert from 'node:assert/strict'
import { createHelperChatDataHost } from './fixtures/helper-chat-data-host.mjs'

async function fixture(t) {
  const host = await createHelperChatDataHost()
  t.after(host.cleanup)
  const invoke = host.invoke
  host.invoke = (method, args) => method === 'updateTavernHelperVariables'
    ? host.adapter.updateVariables(args.sessionId, args.option, args.variables, args.expectedLifecycleRevision, args.eventId, args.contextBaseline)
    : invoke(method, args)
  return host
}

test('local variables share Helper state, save bursts, survive reopening and isolate chats', async t => {
  const host = await fixture(t), run = await host.connect(), local = run.api.variables.local
  assert.equal(local.get('missing'), '')
  assert.equal(local.has('missing'), false)
  assert.equal(local.set('score', '2'), '2')
  assert.equal(local.get('score'), 2)
  assert.equal(local.inc('score'), 3)
  assert.equal(local.dec('score'), 2)
  local.set('other', 'kept')
  assert.equal(run.window.getVariables({ type: 'chat' }).score, 2)
  await run.api.saveMetadata()
  assert.equal((await host.connect()).api.variables.local.get('score'), 2)
  assert.equal((await host.connect('other')).api.variables.local.has('score'), false)
  await run.window.insertOrAssignVariables({ helper: 'visible' }, { type: 'chat' })
  assert.equal(local.get('helper'), 'visible')
  local.del('score')
  await run.api.saveChat()
  const saved = await host.open().read('audit')
  assert.equal(Object.hasOwn(saved.variables, 'score'), false)
  assert.equal(saved.variables.other, 'kept')
  assert.equal(saved.variables.helper, 'visible')
})

test('local save failure is observable and cannot look persisted', async t => {
  const host = await fixture(t), run = await host.connect('audit', (message, dispatch) => {
    if (message.method === 'updateTavernHelperVariables') queueMicrotask(() => run.reply(message, 'disk failed', false))
    else dispatch()
  })
  run.api.variables.local.set('x', 1)
  await assert.rejects(run.api.saveMetadata(), /disk failed/)
  assert.equal(run.api.variables.local.has('x'), false)
  assert.equal((await host.connect()).api.variables.local.has('x'), false)
})

test('separate scripts can save different keys without overwriting each other', async t => {
  const host = await fixture(t), a = await host.connect(), b = await host.connect()
  a.api.variables.local.set('left', 1)
  b.api.variables.local.set('right', 2)
  await Promise.all([a.api.saveMetadata(), b.api.saveMetadata()])
  assert.deepEqual((await host.open().read('audit')).variables, { left: 1, right: 2 })
})

test('an older acknowledgement does not erase a newer synchronous write', async t => {
  const host = await fixture(t), delayed = [], run = await host.connect('audit', (message, dispatch) => {
    if (message.method === 'updateTavernHelperVariables') delayed.push(dispatch)
    else dispatch()
  })
  const local = run.api.variables.local
  local.set('counter', 1); local.set('counter', 2)
  await delayed[0]()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(local.get('counter'), 2)
  await delayed[1]()
  await run.api.saveMetadata()
  assert.equal((await host.open().read('audit')).variables.counter, 2)
})

test('local callback writes finish before the host event receipt', async t => {
  const host = await fixture(t), delayed = [], run = await host.connect('audit', (message, dispatch) => {
    if (message.method === 'updateTavernHelperVariables') delayed.push(dispatch)
    else dispatch()
  })
  run.window.eventOn('write', () => run.api.variables.local.set('result', 'saved'))
  run.receive({ type: 'dsh-tavern-helper-event', name: 'write', eventId: 'local-write', args: [] })
  await new Promise(resolve => setImmediate(resolve))
  const receipt = () => run.sent.find(message => message.type === 'dsh-tavern-helper-event-complete' && message.eventId === 'local-write')
  assert.equal(receipt(), undefined)
  await delayed[0]()
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(receipt())
  assert.equal(receipt().error, undefined)
  assert.equal((await host.open().read('audit')).variables.result, 'saved')
})

test('late writes cannot restore variables after switching chat', async t => {
  const host = await fixture(t), delayed = [], run = await host.connect('audit', (message, dispatch) => {
    if (message.method === 'updateTavernHelperVariables') delayed.push(dispatch)
    else dispatch()
  })
  run.api.variables.local.set('old', 'old chat')
  const saving = assert.rejects(run.api.saveMetadata(), /聊天已切换/)
  run.receive({ type: 'dsh-tavern-helper-context', context: await host.context('other') })
  await delayed[0]()
  await saving
  assert.equal(run.api.variables.local.has('old'), false)
  assert.equal((await host.open().read('other')).variables, undefined)
})

test('local scalar conversions and JSON array appends match supported ST operations', async t => {
  const host = await fixture(t), run = await host.connect(), local = run.api.variables.local
  local.set('text', 'hello'); assert.equal(local.add('text', '!'), 'hello!')
  local.set('list', '[1]'); assert.equal(JSON.stringify(local.add('list', 2)), '[1,2]')
  assert.equal(local.get('list', { index: 1 }), 2)
  local.set('data', { count: 1 })
  const value = local.get('data'); value.count = 99
  assert.equal(local.get('data').count, 1)
  assert.throws(() => local.set('', 1), /名称无效/)
  assert.throws(() => local.set('__proto__', {}), /名称无效/)
  assert.throws(() => local.set('invalid', undefined), /JSON 值/)
  assert.throws(() => local.set('list', 4, { index: 0 }), /暂不支持/)
  await run.api.saveMetadata()
  assert.equal((await host.connect()).api.variables.local.get('list'), '[1,2]')
})
