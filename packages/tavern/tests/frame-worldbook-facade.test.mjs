import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { helperClient } from './fixtures/helper-host-harness.mjs'

test('正式消息首页通过 TavernHelper 获取核心列表，读写仍走宿主 RPC', async () => {
  const html = helperClient.buildTavernFrameDocument({ token: 'core', content: '', helperContext: { worldbook: { name: '绑定世界书' } } })
  const sent = [], handlers = []
  const parent = { postMessage(data) { sent.push(data) } }
  const w = { parent, structuredClone, addEventListener(type, fn) { handlers.push(fn) } }
  w.window = w
  vm.runInNewContext(html.match(/<script data-dsh-tavern-interactive-helper>([\s\S]*?)<\/script>/)[1], w)
  assert.equal(w.TavernHelper.getCharWorldbookNames('current').primary, '绑定世界书')
  const pending = w.TavernHelper.getWorldbook('绑定世界书')
  const request = sent[0]
  assert.equal(request.method, 'getTavernHelperWorldbook')
  handlers.forEach(fn => fn({ source: parent, data: { type: 'dsh-tavern-helper-response', token: 'core', requestId: request.requestId, ok: true, result: { worldbook: { entries: [{ name: '命定系统-标准核心', enabled: true }] } } } }))
  assert.equal((await pending)[0].name, '命定系统-标准核心')
  assert.equal(w.TavernHelper.updateWorldbookWith, w.updateWorldbookWith)
})

test('自定义开局页面追加玩家消息后才能触发生成，并传播追加失败', async () => {
  const html = helperClient.buildTavernFrameDocument({ token: 'journey', content: '', persistent: true, helperContext: { messages: [] } })
  const sent = [], handlers = []
  let rejectCreate = false
  const parent = { postMessage(data) {
    sent.push(data.method)
    queueMicrotask(() => handlers.forEach(fn => fn({ source: parent, data: { type: 'dsh-tavern-helper-response', token: 'journey', requestId: data.requestId, ok: true, result: data.method === 'createTavernHelperMessages' && rejectCreate ? { stale: true } : { updated: true } } })))
  } }
  const w = { parent, structuredClone, addEventListener(type, fn) { handlers.push(fn) } }; w.window = w
  vm.runInNewContext(html.match(/<script data-dsh-tavern-interactive-helper>([\s\S]*?)<\/script>/)[1], w)
  const journey = () => vm.runInNewContext('(async()=>{await createChatMessages([{role:"user",message:"开局"}]); await triggerSlash("/trigger")})()', w)
  await journey()
  assert.deepEqual(sent, ['createTavernHelperMessages', 'triggerTavernSlash'])
  assert.equal(w.TavernHelper.createChatMessages, w.createChatMessages)
  rejectCreate = true; sent.length = 0
  await assert.rejects(journey(), /聊天已变化/)
  assert.deepEqual(sent, ['createTavernHelperMessages'])
})
