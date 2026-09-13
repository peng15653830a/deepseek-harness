import { sessionEvents } from '../tavern-plugin/lib/domain/session-events.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { createInitializationNative } from './fixtures/conversation-initialization-native.mjs'

const native = { skip: !process.env.DSH_BOOT_MODULE, timeout: 30000 }
const openingEvents = session => sessionEvents(session).filter(e => e.type === 'assistant/message' && e.data.turn === 1)

test('oversized import enters native pressure compaction only after subsequent context growth', native, async t => {
  const h=await createInitializationNative(process.env.DSH_BOOT_MODULE)
  t.after(()=>h.dispose())
  const rows=[{chat_metadata:{}},{is_user:false,mes:'Opening'}]
  for(let n=0;n<20;n++) rows.push({is_user:true,mes:'Action '+n},{is_user:false,mes:'History-'+n+' '+'.'.repeat(1000)})
  await h.importHistory({...h.input,text:rows.map(JSON.stringify).join('\n'),operationId:'native-context-test'})
  const result=await h.verifyImportContextCompaction()
  assert.equal(result.chat.importHistory.contextPreparation.status,'trimmed')
  assert.ok(result.afterPreparation<1600)
  assert.equal(result.firstPressure,null)
  assert.equal(result.summaryCallsBeforeGrowth,0)
  assert.ok(result.result)
  assert.ok(result.afterCompaction<1600)
  assert.equal(h.requests.filter(r=>r.purpose==='compaction').length,1)
  assert.equal(result.chat.messages.length,41)
  assert.ok(result.events.some(e=>e.type==='compaction/end'))
})

test('native card workbench starts empty or with a card and restores its greeting only once', native, async t => {
  for (const cardPath of ['', 'cards/test.json']) {
    const h = await createInitializationNative(process.env.DSH_BOOT_MODULE)
    t.after(() => h.dispose())
    const chat = await h.open().start({ ...h.input, cardPath, mode: 'card' })
    assert.equal(chat.mode, 'card')
    assert.equal(chat.nativeOpeningAppended, true)
    assert.equal(openingEvents(h.target.session).length, 1)
    const initialMessages = h.target.session.deriveMessages()
    assert.deepEqual(initialMessages.map(message => message.role), ['user', 'assistant', 'user', 'assistant'])
    assert.match(initialMessages[0].content[0].text, /待编辑素材/)
    assert.equal(initialMessages[3].content[0].text, '工作台')
    await h.restoreDetached()
    const restored = await h.open().ensureOpening(h.input.sessionId)
    assert.equal(restored.id, chat.id)
    assert.equal(openingEvents(h.target.session).length, 1)
    assert.equal(h.requests.length, 0)
    assert.deepEqual(h.target.session.deriveMessages(), initialMessages)
    await h.continueWithAgent()
    assert.ok(h.requests[0].messages.some(message => message.content?.some(block => /待编辑素材/.test(block.text || ''))))
  }
})

test('native Session and disk Chat journal recover a failed marker once, then actual Agent starts at turn two', native, async t => {
  const h = await createInitializationNative(process.env.DSH_BOOT_MODULE)
  t.after(() => h.dispose())
  h.state.failMarker = true
  await assert.rejects(h.open().start(h.input), /marker failure/)
  assert.equal(openingEvents(h.target.session).length, 1)
  assert.equal(h.requests.length, 0, 'opening never calls a model')
  await h.restoreDetached()
  h.state.failMarker = false
  const recovered = await h.open().ensureOpening(h.input.sessionId)
  assert.equal(recovered.nativeOpeningAppended, true)
  assert.equal(openingEvents(h.target.session).length, 1)
  assert.equal(h.target.session.deriveMessages().length, 5)
  assert.equal(h.target.session.deriveMessages()[0].source.form, 'snapshot')
  assert.equal((await h.persistence.read(recovered.id)).nativeOpeningAppended, true)
  await h.continueWithAgent()
  assert.equal(h.requests.length, 1)
  const messages = h.requests[0].messages
  assert.match(h.requests[0].system, /不可丢失的固定背景/)
  assert.ok(messages.every(message => !JSON.stringify(message.content).includes('不可丢失的固定背景')))
  assert.equal(h.target.session.requestHeader().system, h.requests[0].system)
  assert.equal(messages.filter(m => m.role === 'assistant' && JSON.stringify(m.content).includes('玩家，你好。')).length, 1)
  assert.deepEqual(sessionEvents(h.target.session).filter(e => e.type === 'turn/start').map(e => e.data.turn), [1, 2])
  assert.equal(sessionEvents(h.target.session).at(-1).type, 'turn/end')
})

test('native partial event logs survive disk reload and Session end-seed markers at every append boundary', native, async t => {
  for (const stage of ['turn/start', 'step/start', 'assistant/message', 'step/end', 'turn/end']) {
    const h = await createInitializationNative(process.env.DSH_BOOT_MODULE)
    t.after(() => h.dispose())
    const session = h.target.session, append = session.append.bind(session)
    session.append = (type, ...args) => { if (type === stage) throw Error('append failure'); return append(type, ...args) }
    await assert.rejects(h.open().start(h.input), /append failure/)
    session.append = append
    const before = structuredClone(sessionEvents(session))
    await h.checkpoint()
    await h.restoreDetached()
    const recovered = await h.open().ensureOpening(h.input.sessionId)
    assert.equal(recovered.nativeOpeningAppended, true)
    assert.deepEqual(sessionEvents(h.target.session).slice(0, before.length), before)
    assert.equal(openingEvents(h.target.session).length, 1)
    assert.equal(h.target.session.deriveMessages().length, 5)
    assert.equal(h.target.session.deriveMessages()[0].source.form, 'snapshot')
    assert.equal(sessionEvents(h.target.session).filter(e => e.type === 'turn/end').length, 1)
  }
})

test('failed native flush restores only durable events and finishes the published Chat without another Chat', native, async t => {
  const h = await createInitializationNative(process.env.DSH_BOOT_MODULE)
  t.after(() => h.dispose())
  h.state.failFlush = true
  await assert.rejects(h.open().start(h.input), /native flush failure/)
  assert.equal(openingEvents(h.target.session).length, 0, 'the pre-opening seed flush failed before the greeting was appended')
  await h.restoreDetached()
  assert.equal(openingEvents(h.target.session).length, 0, 'failed flush did not persist the greeting')
  h.state.failFlush = false
  const recovered = await h.open().start(h.input)
  assert.equal(recovered.nativeOpeningAppended, true)
  assert.equal(openingEvents(h.target.session).length, 1)
  assert.equal((await h.open().ensureOpening(h.input.sessionId)).id, recovered.id)
  assert.equal(h.requests.length, 0)
})

 test('imported native history survives disk restore and reaches the next real Agent request exactly once', native, async t => {
 const h = await createInitializationNative(process.env.DSH_BOOT_MODULE)
 t.after(() => h.dispose())
 const text = [{chat_metadata:{}},{is_user:false,mes:'导入开场'}, {is_user:true,mes:'走到花店'}, {is_user:false,mes:'抵达花店'}, {is_user:true,mes:'返回邮局'}, {is_user:false,mes:'已回邮局'}].map(JSON.stringify).join('\n')
 await h.importHistory({...h.input,text,operationId:'native-import-test'})
 assert.equal(h.requests.length,0)
 await h.restoreDetached()
 await h.continueWithAgent()
 assert.equal(h.requests.length,1)
 assert.equal(h.requests[0].messages.filter(m=>m.source?.form==='foreground-frame').length,2)
 assert.equal(h.requests[0].messages.filter(m=>m.content.some(b=>b.type==='text' && b.text.includes('Native fixture writing rules'))).length,2)
 const actual=h.requests[0].messages.map(m=>m.content.filter(b=>b.type==='text').map(b=>b.text).join('\n'))
 for(const phrase of ['导入开场','走到花店','抵达花店','返回邮局','已回邮局','继续。']) assert.equal(actual.filter(t=>t===phrase).length,1)
 assert.doesNotMatch(JSON.stringify(actual),/玩家，你好。/)
 for (const phrase of ['不可丢失的固定背景', 'Fixture constant worldbook', 'Fixture recalled worldbook',
   'Fixture card special instruction', 'Fixture card writing constraint']) {
   assert.ok([h.requests[0].system, ...actual].some(text => text?.includes(phrase)), phrase + ' must reach the model adapter')
 }
 assert.equal(sessionEvents(h.target.session).filter(e=>e.type==='turn\/start').at(-1).data.turn,4)
 })
