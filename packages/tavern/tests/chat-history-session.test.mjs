import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createContextPlanner } from '../tavern-plugin/lib/domain/context-planner.js'
const storyRules = readFileSync(new URL('../tavern-plugin/prompts/story.md', import.meta.url), 'utf8')
const framePlan = await createContextPlanner({ prompt: () => storyRules }).plan({purpose:'body',card:{},chat:{}})
const storyMessages = session => session.deriveMessages().filter(m => m.source?.form !== 'foreground-frame')
import assert from 'node:assert/strict'
import { Session, KNOWN_SESSION_EVENT_TYPES } from './fixtures/dsh-session-host.mjs'
import { parseChatHistory } from '../tavern-plugin/lib/domain/chat-history-import.js'
import { buildImportedConversation, appendImportedEvents } from '../tavern-plugin/lib/domain/chat-history-session.js'
import { createStoryTimeline } from '../tavern-plugin/lib/domain/story-timeline.js'
import { locateRollbackSurface } from '../tavern-plugin/lib/domain/rollback-surface.js'
import { sessionEvents } from '../tavern-plugin/lib/domain/session-events.js'
const timeline = createStoryTimeline()
function plan() {
  const text = [{ chat_metadata: {} }, { is_user: false, mes: 'opening', variables: [{stat_data:{hp:10}}] },
    { is_user: true, mes: 'walk' }, { is_user: false, mes: 'arrived', variables: [{stat_data:{hp:9}}] },
    { is_user: true, mes: 'rest' }, { is_user: false, mes: 'rested', variables: [{stat_data:{hp:12}}] }].map(JSON.stringify).join('\n')
  const chat = timeline.apply({ chat: { id:'chat', messages:[], scriptState:null, mvu:{enabled:true,owner:'official',runtime:'magvarupdate'} }, intent:{kind:'ensure'} }).chat
  return buildImportedConversation(chat, parseChatHistory(text), {operationId:'import-test',framePlan})
}
test('real host restores imported roles and turns without model execution', async () => {
  const p = await plan(), session = Session.create('import-test')
  await appendImportedEvents(session, p, async()=>{})
  const contexts = session.deriveMessages().filter(m => m.source?.form === 'foreground-frame')
  assert.equal(contexts.length, 2)
  for (const [index, context] of contexts.entries()) {
    assert.ok(context.content[0].text.includes(storyRules.trim()))
    assert.ok(context.source.sections.some(section => section.text === storyRules.trim()))
    assert.equal(context.source.trace.turn, index + 2)
    assert.match(context.content[0].text, /变量更新由正文提交后的后台 Agent/)
  }
  assert.deepEqual(session.deriveMessages().map(m => m.source?.form || m.role),
    ['assistant','user','foreground-frame','assistant','user','foreground-frame','assistant'])
  assert.ok(sessionEvents(session).every(event => KNOWN_SESSION_EVENT_TYPES.has(event.type)), 'persisted imports must use only the host event vocabulary')
  assert.deepEqual(storyMessages(session).map(m=>m.content[0].text), ['opening','walk','arrived','rest','rested'])
  const restored = Session.create(session.id, sessionEvents(session), session.header)
  assert.deepEqual(restored.deriveMessages(), session.deriveMessages())
  assert.equal(locateRollbackSurface({events:sessionEvents(restored),nodes:restored.surface.nodes}).turn,3)
  await appendImportedEvents(restored,p,async()=>{})
  assert.equal(storyMessages(restored).length,5)
})
test('successive rollback restores selected MVU states without storage-history snapshots', async () => {
  let chat=(await plan()).chat
  for (const checkpoint of chat.timeline.checkpoints) {
    checkpoint.before = { ...checkpoint.importBefore, messages: structuredClone(chat.messages.slice(0, checkpoint.importMessageCount)) }
    delete checkpoint.importBefore; delete checkpoint.importMessageCount
  }
  chat=timeline.apply({chat,intent:{kind:'turn.rollback',turn:3}}).chat
  assert.equal(chat.messages.at(-1).text,'arrived')
  assert.equal(chat.messages.at(-1).variables[0].stat_data.hp,9)
  chat=timeline.apply({chat,intent:{kind:'turn.rollback',turn:2}}).chat
  assert.equal(chat.messages.length,1)
  assert.equal(chat.messages[0].variables[0].stat_data.hp,10)
  assert.equal(chat.timeline.participants.background.status,'needs-session')
})
test('consecutive roles form native rounds and retain every paragraph and the final state',async()=>{
 const rows=[{chat_metadata:{}},{is_user:false,mes:'opening'},{is_user:false,mes:'opening continued'},
  {is_user:true,mes:'go'},{is_user:true,mes:'carefully'},{is_user:false,mes:'arrived',variables:[{stat_data:{hp:8}}]},
  {is_user:false,mes:'and rested',variables:[{stat_data:{hp:9}}]}]
 const chat=timeline.apply({chat:{id:'chat',messages:[],scriptState:null},intent:{kind:'ensure'}}).chat
 const p=await buildImportedConversation(chat,parseChatHistory(rows.map(JSON.stringify).join('\n')),{operationId:'grouped-test',framePlan})
 const session=Session.create('grouped-test')
 await appendImportedEvents(session,p,async()=>{})
 assert.deepEqual(storyMessages(session).map(m=>m.content[0].text),['opening\n\nopening continued','go\n\ncarefully','arrived\n\nand rested'])
 assert.equal(p.chat.timeline.checkpoints.length,1)
 assert.equal(p.chat.messages.at(-1).variables[0].stat_data.hp,9)
 assert.deepEqual(p.chat.messages.at(-1).importSource.lines,[6,7])
 const surface=locateRollbackSurface({events:sessionEvents(session),nodes:session.surface.nodes})
 assert.equal(surface.turn,2)
 session.append('assistant/message',{turn:2,step:1,message:{id:'rollback',role:'assistant',content:[],source:surface.source}},
  {surfaceOp:{op:'replace',start:surface.userSeq,end:surface.endSeq},sourceEventSeqs:surface.shadowedSeqs})
 assert.deepEqual(storyMessages(session).flatMap(m=>m.content.map(b=>b.text)),['opening\n\nopening continued'])
})
