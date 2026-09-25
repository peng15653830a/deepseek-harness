import test from 'node:test'
import assert from 'node:assert/strict'
import {createIncrementalReplyView} from '../tavern-plugin/lib/domain/incremental-reply-view.js'
import {projectRuntimeReplyHistory} from '../tavern-plugin/lib/domain/runtime-content-projection.js'
import {projectPersistentStatusView} from '../tavern-plugin/lib/domain/persistent-status-view.js'
const options={charName:'角色',macroState:{userName:'玩家'}}
function reference(chat, opts=options) {
 const history=projectRuntimeReplyHistory(chat.messages,opts)
 return {...projectPersistentStatusView(chat.messages,history.projections,opts),presentation:null,latestSourceBacked:history.latestSourceBacked}
}
test('无变化复用、追加和修改局部投影，删除用户改变后续推断轮次时重算后缀',async()=>{
 let chat={id:'chat',_storageRevision:1,messages:[{role:'assistant',text:'开场',bodyEdit:true},{role:'user',text:'输入'},{role:'assistant',text:'<b>正文</b>',sourceText:'<b>正文</b>'}]}
 let changed=[]
 const cache=createIncrementalReplyView({readChanges:async(id,rev)=>({baseRevision:rev,chat,messageCount:chat.messages.length,denseMessages:true,indices:changed})})
 assert.deepEqual(await cache.project(chat,options,options),reference(chat))
 const count=cache.stats().projectedMessages
 assert.deepEqual(await cache.project(structuredClone(chat),options,options),reference(chat))
 assert.equal(cache.stats().projectedMessages,count)
 chat.messages.push({role:'user',text:'下一轮'},{role:'assistant',text:'新增',bodyEdit:true});changed=[3,4];chat._storageRevision++
 assert.deepEqual(await cache.project(chat,options,options),reference(chat))
 assert.equal(cache.stats().projectedMessages,count+1)
 chat.messages[2].text='<i>修改</i>';chat.messages[2].sourceText=chat.messages[2].text;changed=[2];chat._storageRevision++
 assert.deepEqual(await cache.project(chat,options,options),reference(chat))
 assert.equal(cache.stats().projectedMessages,count+2)
 chat.messages.splice(1,1);changed=[1,2,3];chat._storageRevision++
 assert.deepEqual(await cache.project(chat,options,options),reference(chat))
 const before=cache.stats().projectedMessages;changed=[];chat._storageRevision++
 assert.deepEqual(await cache.project(chat,options,options),reference(chat));assert.equal(cache.stats().projectedMessages,before)
})
test('依赖、分支或变化范围不可确认时重建，返回数据不能污染缓存，容量受限',async()=>{
 const chat={id:'chat',_storageRevision:1,messages:[{role:'assistant',text:'<b>{{user}}</b>'}]}
 const cache=createIncrementalReplyView({readChanges:async()=>{throw Error('增量证据暂不可读')}})
 const first=await cache.project(chat,options,options);first.projections[0].parts[0].content='污染'
 assert.deepEqual(await cache.project(chat,options,options),reference(chat))
 const changed={...options,macroState:{userName:'新名字'}}
 assert.deepEqual(await cache.project(chat,changed,changed),reference(chat,changed))
 chat._storageRevision++;assert.deepEqual(await cache.project(chat,options,options),reference(chat))
 chat.timeline={branchId:'new'};await cache.project(chat,options,options)
 assert.equal(cache.stats().rebuilt,4)
 const small=createIncrementalReplyView({maxBytes:1});await small.project(chat,options,options);assert.equal(small.stats().entries,0)
})

test('真实 journal 支持新增/旧正文改写及无消息变化，重启缺少变更证据时回退', async t => {
 const {mkdtemp,rm}=await import('node:fs/promises'), {tmpdir}=await import('node:os'), {join}=await import('node:path')
 const {createChatJournalStore}=await import('../tavern-plugin/lib/domain/chat-journal-store.js')
 const root=await mkdtemp(join(tmpdir(),'incremental-view-'));t.after(()=>rm(root,{recursive:true,force:true}))
 let store=createChatJournalStore({dataRoot:root})
 const cache=createIncrementalReplyView({readChanges:(id,revision)=>store.readChangedSlice(id,revision)})
 let chat=await store.update('chat',()=>({id:'chat',_storageRevision:1,messages:Array.from({length:700},(_,i)=>({role:'assistant',turn:i+1,text:'正文'+i,bodyEdit:true}))}))
 const check=async()=>assert.deepEqual(await cache.project(chat,options,options),reference(chat))
 await check();assert.equal(cache.stats().projectedMessages,700)
 chat=await store.update('chat',current=>({...current,_storageRevision:2,messages:[...current.messages,{role:'assistant',turn:701,text:'新正文',bodyEdit:true}]}))
 await check();assert.equal(cache.stats().projectedMessages,701)
 chat=await store.update('chat',current=>{current._storageRevision++;current.messages[100].text='编辑旧正文';return current})
 await check();assert.equal(cache.stats().projectedMessages,702)
 chat=await store.update('chat',current=>({...current,_storageRevision:4,posture:'更新状态'}))
 await check();assert.equal(cache.stats().projectedMessages,702)
 store=createChatJournalStore({dataRoot:root})
 chat=await store.update('chat',current=>({...current,_storageRevision:5,posture:'重启后'}))
 store=createChatJournalStore({dataRoot:root})
 await check();assert.equal(cache.stats().rebuilt,2)
})

test('新版变更证据不能应用到旧快照，正则改变和回退仍与全量一致',async()=>{
 const chat={id:'chat',_storageRevision:1,messages:[{role:'assistant',text:'旧内容',bodyEdit:true}]}
 const cache=createIncrementalReplyView({readChanges:async(id,revision)=>({baseRevision:revision,chat:{_storageRevision:chat._storageRevision+1},messageCount:1,denseMessages:true,indices:[0]})})
 await cache.project(chat,options,options)
 chat._storageRevision=2;chat.messages[0].text='新内容'
 assert.deepEqual(await cache.project(chat,options,options),reference(chat))
 assert.equal(cache.stats().rebuilt,2)
 const changed={...options,regexScripts:[{findRegex:'新内容',replaceString:'<b>替换内容</b>',placement:[2],markdownOnly:true}]}
 assert.deepEqual(await cache.project(chat,changed,changed),reference(chat,changed))
 chat.messages=[];chat._storageRevision=3
 assert.deepEqual(await cache.project(chat,changed,changed),reference(chat,changed))
})


test('游戏变量每轮变化仍只投影新增正文，空闲状态更新不重算历史', async () => {
 let chat = { id: 'variable-updates', _storageRevision: 1, messages: Array.from({length: 40}, (_, i) => ({role: 'assistant', turn: i + 1, text: '<p>{{user}} 正文' + i + '</p>', bodyEdit: true})) }
 let indices = []
 const cache = createIncrementalReplyView({readChanges: async (_, revision) => ({baseRevision: revision, chat, messageCount: chat.messages.length, denseMessages: true, indices})})
 const opts = revision => ({...options, macroState: {...options.macroState, variables: {hp: revision}, turn: revision}})
 const first = await cache.project(chat, opts(1), opts(1))
 chat = {...chat, _storageRevision: 2, messages: [...chat.messages, {role: 'assistant', turn: 41, text: '<p>新增</p>', bodyEdit: true}]}
 indices = [40]
 const next = await cache.project(chat, opts(2), opts(2))
 assert.equal(cache.stats().projectedMessages, 41)
 assert.deepEqual(next.projections.slice(0, 40), first.projections)
 indices = []; chat._storageRevision++
 await cache.project(chat, opts(3), opts(3))
 assert.equal(cache.stats().projectedMessages, 41)
 assert.equal(cache.stats().rebuilt, 1)
})
