import test from 'node:test'
import assert from 'node:assert/strict'
import { Session, KNOWN_SESSION_EVENT_TYPES } from './fixtures/dsh-session-host.mjs'
import { createImportContextPreparation, planImportContext } from '../tavern-plugin/lib/domain/import-context-preparation.js'
import { buildImportedConversation, appendImportedEvents } from '../tavern-plugin/lib/domain/chat-history-session.js'
import { parseChatHistory } from '../tavern-plugin/lib/domain/chat-history-import.js'
import { createStoryTimeline } from '../tavern-plugin/lib/domain/story-timeline.js'
import { createHistoryRecall } from '../tavern-plugin/lib/domain/history-recall.js'
import { locateRollbackSurface } from '../tavern-plugin/lib/domain/rollback-surface.js'
import { sessionEvents } from '../tavern-plugin/lib/domain/session-events.js'
const estimateMessage = message => message.content.reduce((n,b)=>n+(b.text?.length||0),0)+8
async function fixture() {
  const session=Session.create('context-test')
  session.append('user/message',{id:'tavern-session-prefix:context-test',role:'user',content:[{type:'text',text:'Fixed setting'}],source:{kind:'plugin',plugin:'dsh-tavern',form:'snapshot'}},{surfaceOp:'append'})
  const rows=[{chat_metadata:{}},{is_user:false,mes:'Original opening'}]
  for(let n=0;n<12;n++)rows.push({is_user:true,mes:'action '+n},{is_user:false,mes:'Secret-'+n+' '+(n===11?'RevokedOnlyQuartz ':'')+'.'.repeat(200)})
  let chat=createStoryTimeline().apply({chat:{id:'chat',sessionId:session.id,mode:'story',messages:[],scriptState:null},intent:{kind:'ensure'}}).chat
  const plan=await buildImportedConversation(chat,parseChatHistory(rows.map(JSON.stringify).join('\n')),{operationId:'import-context-test',framePlan:{text:'Rules',sections:[{kind:'base',required:true,text:'Rules'}]}})
  await appendImportedEvents(session,plan,async()=>{})
  session.append('user/message',{id:'new-input',role:'user',content:[{type:'text',text:'Continue'}],source:{kind:'user'}},{surfaceOp:'append'})
  const request={sessionId:session.id,provider:'fixture',model:'small',system:'System rules',messages:session.deriveMessages(),maxTokens:200}
  let capacity=1200,failSave=false,modelCalls=0,flushes=0
  const options={readChat:async()=>structuredClone(chat),updateChat:async(id,fn)=>{if(failSave){failSave=false;throw Error('save failed')}chat=fn(structuredClone(chat))},getSession:()=>session,
    flush:async()=>{flushes++},modelInfo:async()=>{modelCalls++;return {context:{contextWindow:capacity}}},estimateMessage}
  return {session,request,options,get chat(){return chat},get flushes(){return flushes},get modelCalls(){return modelCalls},failSave:()=>{failSave=true},capacity:n=>{capacity=n}}
}
test('only oversized imports trim the middle to below 80 percent while preserving head and recent complete rounds',async()=>{
  const h=await fixture()
  const result=planImportContext({session:h.session,request:h.request,operationId:h.chat.importHistory.operationId,contextWindow:1200,estimateMessage})
  assert.equal(result.status,'trimmed')
  assert.ok(result.afterTokens<1200*.8)
  assert.equal(result.removedIds.length%3,0,'input, frame and assistant stay together')
  assert.ok(!result.removedIds.includes('new-input'))
  const large=planImportContext({session:h.session,request:h.request,operationId:h.chat.importHistory.operationId,contextWindow:10000,estimateMessage})
  assert.equal(large.status,'unchanged')
  const projected=await createImportContextPreparation(h.options).prepare(h.request)
  const texts=projected.messages.map(m=>m.content.map(b=>b.text||'').join('')).join('\n')
  assert.match(texts,/Fixed setting/);assert.match(texts,/Original opening/);assert.match(texts,/Secret-11/);assert.match(texts,/Continue/)
  assert.doesNotMatch(texts,/Secret-0 /)
})
test('native Surface shrinks durably but history_recall still searches and reads excluded rounds',async()=>{
  const h=await fixture(),before=structuredClone(h.chat.messages),initialCount=sessionEvents(h.session).length
  const service=createImportContextPreparation(h.options)
  await service.prepare(h.request)
  assert.deepEqual(h.chat.messages,before)
  const recall=createHistoryRecall()
  const search=recall.recall({chat:h.chat,query:'Secret-0'})
  assert.equal(search.found,true)
  assert.match(JSON.stringify(recall.recall({chat:h.chat,turn:2,radius:0})),/Secret-0/)
  assert.doesNotMatch(JSON.stringify(h.session.deriveMessages()),/Secret-0 /)
  const restored=Session.create(h.session.id,sessionEvents(h.session),h.session.header)
  assert.deepEqual(restored.deriveMessages(),h.session.deriveMessages())
  assert.ok(sessionEvents(h.session).every(e=>KNOWN_SESSION_EVENT_TYPES.has(e.type)))
  assert.equal(sessionEvents(h.session).length,initialCount+1)
  await service.prepare({...h.request,messages:h.session.deriveMessages()})
  assert.equal(sessionEvents(h.session).length,initialCount+1)
  assert.equal(h.modelCalls,1)
})
test('retry after publication failure reuses the durable replacement rather than trimming again',async()=>{
  const h=await fixture();h.failSave()
  await assert.rejects(createImportContextPreparation(h.options).prepare(h.request),/save failed/)
  const count=sessionEvents(h.session).length
  await createImportContextPreparation(h.options).prepare(h.request)
  assert.equal(sessionEvents(h.session).length,count)
  assert.equal(h.chat.importHistory.contextPreparation.status,'trimmed')
  assert.equal(h.modelCalls,1)
})
test('capacity exclusion stays recallable, but a native story rollback removes the revoked round from recall',async()=>{
  const h=await fixture()
  await createImportContextPreparation(h.options).prepare(h.request)
  await h.options.updateChat(h.chat.id,chat=>{
    const checkpoint=chat.timeline.checkpoints.at(-1)
    checkpoint.before={...checkpoint.importBefore,messages:structuredClone(chat.messages.slice(0,checkpoint.importMessageCount))}
    return createStoryTimeline().apply({chat,intent:{kind:'turn.rollback',turn:checkpoint.turn}}).chat
  })
  const recall=createHistoryRecall()
  assert.equal(recall.recall({chat:h.chat,query:'Secret-0'}).found,true,'capacity-excluded history still happened')
  assert.equal(recall.recall({chat:h.chat,query:'RevokedOnlyQuartz'}).found,false,'rolled-back history was revoked')
  assert.equal(recall.recall({chat:h.chat,turn:13,radius:0}).found,false)
})
test('unknown model capacity and an oversized mandatory tail fail before touching the Surface',async()=>{
  for(const capacity of [undefined,200]){
    const h=await fixture();h.capacity(capacity)
    const before=sessionEvents(h.session).length
    await assert.rejects(createImportContextPreparation(h.options).prepare(h.request),/模型|容量/)
    assert.equal(sessionEvents(h.session).length,before)
  }
})
test('normal sessions bypass preparation and a native reply can roll back across the preparation marker',async()=>{
  const h=await fixture()
  await createImportContextPreparation({...h.options,readChat:async()=>({messages:[]})}).prepare(h.request)
  assert.equal(h.modelCalls,0)
  await createImportContextPreparation(h.options).prepare(h.request)
  h.session.append('assistant/message',{turn:14,step:1,message:{id:'new-body',role:'assistant',content:[{type:'text',text:'New body'}],source:{kind:'model',provider:'fixture',model:'small'}}},{surfaceOp:'append',sourceEventSeqs:[]})
  const surface=locateRollbackSurface({events:sessionEvents(h.session),nodes:h.session.surface.nodes})
  assert.equal(sessionEvents(h.session).find(e=>e.seq===surface.userSeq).data.id,'new-input')
  assert.equal(surface.turn,14)
})
