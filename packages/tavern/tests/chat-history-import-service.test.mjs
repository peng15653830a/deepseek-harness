import { projectWorldBookTemplates } from '../tavern-plugin/lib/domain/worldbook-recall.js'
import { TavernPromptTemplateRuntime } from '../tavern-plugin/lib/domain/tavern-prompt-template-runtime.js'
import test from 'node:test'
import { createContextPlanner } from '../tavern-plugin/lib/domain/context-planner.js'
import assert from 'node:assert/strict'
import { Session } from './fixtures/dsh-session-host.mjs'
import { createChatHistoryImportService } from '../tavern-plugin/lib/domain/chat-history-import-service.js'
import { createStoryTimeline } from '../tavern-plugin/lib/domain/story-timeline.js'
import { sessionEvents } from '../tavern-plugin/lib/domain/session-events.js'
const timeline = createStoryTimeline()
const text = [ {chat_metadata:{}}, {is_user:false,mes:'opening',variables:[{stat_data:{hp:10},schema:{}}]},
 {is_user:true,mes:'walk'}, {is_user:false,mes:'walked',variables:[{stat_data:{hp:8},schema:{}}]},
 {is_user:true,mes:'rest'}, {is_user:false,mes:'rested',variables:[{stat_data:{hp:9},schema:{}}]} ].map(JSON.stringify).join('\n')
function fixture() {
 const journals=new Map(), records=new Map(), history=new Map(), links=new Map()
 const session=Session.create('session'), phase={kind:'idle',lastTurn:0}
 let publishes=0, failFlush=false
 const clone=x=>x===undefined?undefined:structuredClone(x)
 const chats={resolve:async id=>clone(links.get(id)),read:async id=>clone(records.get(id)),readRevision:async(id,revision)=>clone(history.get(revision)),
  write:async chat=>{ const saved={...clone(chat),_storageRevision:(records.get(chat.id)?._storageRevision||0)+1};records.set(chat.id,saved);history.set(saved._storageRevision,clone(saved));return clone(saved)},
  publish:async chat=>{publishes++;await chats.write(chat);links.set(chat.sessionId,clone(chat))}}
 const options={planner:createContextPlanner({prompt:()=> 'Fixture writing rules'}),cards:{read:async()=>({name:'card'})},worldBooks:{bound:async()=>({view:{entries:[{comment:'[initvar]',content:'hp: 10'}]}})},
 store:{readJson:async p=>clone(journals.get(p)),writeJson:async(p,v)=>journals.set(p,clone(v))},chats,
 initialization:{prepareImport:async()=>timeline.apply({chat:{id:'chat',sessionId:'session',messages:[],mvu:{enabled:true},scriptState:null,cardContextSnapshot:'rules'},intent:{kind:'ensure'}}).chat},
 native:{wait:async()=>({session,agent:{phase}}),ensurePrefix:async()=>{},flush:async()=>{if(failFlush){failFlush=false;throw Error('offline')}}}}
 return {options,session,phase,history,chats,records,get publishes(){return publishes},fail:()=>{failFlush=true}}
}
const input={cardPath:'card.json',text,operationId:'operation-123',sessionId:'session'}
test('import uses normal storage revision checkpoints, keeps no pending settlement, retries idempotently',async()=>{
 const h=fixture(), service=createChatHistoryImportService(h.options)
 await service.import(input)
 let chat=await h.chats.resolve('session')
 assert.equal(chat.timeline.checkpoints.length,2)
 assert.equal(chat.settleStatus,'done');assert.equal(h.phase.lastTurn,3)
 assert.ok(chat.timeline.checkpoints.every(c=>c.beforeRevision>0 && !c.importBefore))
 const checkpoint=chat.timeline.checkpoints.at(-1)
 chat=timeline.apply({chat,intent:{kind:'turn.rollback',turn:3,beforeChat:h.history.get(checkpoint.beforeRevision)}}).chat
 assert.equal(chat.messages.at(-1).variables[0].stat_data.hp,8)
 await service.import(input)
 assert.equal(h.publishes,1)
 assert.equal(h.session.deriveMessages().filter(m=>m.source?.form!=='foreground-frame').length,5)
})
test('after flush failure a fresh coordinator resumes durable plan without duplicate native messages',async()=>{
 const h=fixture();h.fail()
 await assert.rejects(createChatHistoryImportService(h.options).import(input),/offline/)
 assert.equal(h.publishes,0)
 const before=sessionEvents(h.session).length
 await createChatHistoryImportService(h.options).import(input)
 assert.equal(sessionEvents(h.session).length,before)
 assert.equal(h.publishes,1)
})
test('schema mismatch requires an explicit text-only choice and uses initial state',async()=>{
 const h=fixture();const bad={...input,text:text.replaceAll('"hp"','"other"')}
 const service=createChatHistoryImportService(h.options)
 assert.equal((await service.preview(bad)).incompatible,true)
 await assert.rejects(service.import(bad),/不兼容/)
 await service.import({...bad,textOnly:true})
 assert.deepEqual((await h.chats.resolve('session')).messages.at(-1).variables[0].stat_data,{hp:10})
})
test('only the latest 40 checkpoints are retained',async()=>{
 const h=fixture(),rows=[{chat_metadata:{}},{is_user:false,mes:'opening'}]
 for(let i=0;i<45;i++)rows.push({is_user:true,mes:'go '+i},{is_user:false,mes:'reply '+i})
 await createChatHistoryImportService(h.options).import({...input,text:rows.map(JSON.stringify).join('\n')})
 assert.equal((await h.chats.resolve('session')).timeline.checkpoints.length,40)
})
test('publication cleanup can be retried with intact native checkpoint revisions',async()=>{
 const h=fixture(),publish=h.chats.publish
 let fail=true
 h.chats.publish=async chat=>{
  if(fail){fail=false;h.records.clear();h.history.clear();throw Error('publish failed')}
  return publish(chat)
 }
 await assert.rejects(createChatHistoryImportService(h.options).import(input),/publish failed/)
 const eventCount=sessionEvents(h.session).length
 await createChatHistoryImportService(h.options).import(input)
 const chat=await h.chats.resolve('session')
 assert.ok(chat.timeline.checkpoints.every(c=>h.history.has(c.beforeRevision)))
 assert.equal(h.history.get(chat.timeline.checkpoints.at(-1).beforeRevision).messages.at(-1).text,'walked')
 assert.equal(sessionEvents(h.session).length,eventCount)
})
test('concurrent requests cannot reuse an operation for different content',async()=>{
 const h=fixture(),service=createChatHistoryImportService(h.options)
 const first=service.import(input)
 await assert.rejects(service.import({...input,textOnly:true}),/其他内容/)
 await first
})

test('import rebuilds card instructions and worldbook context against each historical state', async () => {
 const h=fixture(), seen=[], runtime=await TavernPromptTemplateRuntime.create()
 h.options.cards.read=async()=>({name:'card',system_prompt:'Card special rule',post_history_instructions:'Card writing constraint'})
 h.options.worldBooks.bound=async()=>({view:{entries:[{comment:'[initvar]',content:'hp: 10'},
  {ref:'walking',enabled:true,primaryKeys:['opening'],content:'Opening worldbook rule'},
  {ref:'resting',enabled:true,primaryKeys:['walked'],content:'Walked worldbook rule'},
  {ref:'template',enabled:true,constant:true,content:'<% print("Historical HP " + getvar("stat_data.hp")) %>'}]}})
 h.options.projectWorldBookTemplates=async(chat)=>{
  const hp=chat.messages.at(-1)?.variables?.[0]?.stat_data.hp
  seen.push(hp)
  return projectWorldBookTemplates({chat, card:await h.options.cards.read(), worldBook:await h.options.worldBooks.bound(), runtime})
 }
 await createChatHistoryImportService(h.options).import(input)
 const frames=h.session.deriveMessages().filter(m=>m.source?.form==='foreground-frame').map(m=>m.content[0].text)
 assert.equal(frames.length,2)
 assert.match(frames[0],/Opening worldbook rule/)
 assert.doesNotMatch(frames[0],/Walked worldbook rule/)
 assert.match(frames[1],/Walked worldbook rule/)
 for(const frame of frames){assert.match(frame,/Card special rule/);assert.match(frame,/Card writing constraint/);assert.match(frame,/Fixture writing rules/)}
 assert.deepEqual(seen,[10,8])
 assert.match(frames[0],/Historical HP 10/);assert.match(frames[1],/Historical HP 8/)
 const chat=await h.chats.resolve('session')
 const before=h.history.get(chat.timeline.checkpoints.at(-1).beforeRevision)
 assert.ok(before.worldBookReads.walking)
 assert.equal(before.worldBookReads.resting,undefined)

})
