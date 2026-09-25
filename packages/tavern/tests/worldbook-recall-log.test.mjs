import test from 'node:test'
import assert from 'node:assert/strict'
import { prepareWorldBookRecall } from '../tavern-plugin/lib/domain/worldbook-recall.js'
import { createWorldbookRecallLog } from '../tavern-plugin/lib/domain/worldbook-recall-log.js'
import { createForegroundWorldbook } from '../tavern-plugin/lib/domain/foreground-worldbook.js'
import { UpstreamTemplateRuntime } from './fixtures/upstream-template-runtime.mjs'

const entry = (ref, order, extra = {}) => ({ ref, order, title: ref, enabled: true, content: '设定 ' + ref, primaryKeys: ['少林'], ...extra })
test('日志区分当前输入和历史命中，并解释低优先级条目为何被 token 预算拒绝', async () => {
 const entries = Array.from({length:6},(_,i)=>entry('entry:'+i,i))
 entries.push(entry('secondary',100,{secondaryKeys:['午夜'],selective:true,selectiveLogic:0}))
 const result=prepareWorldBookRecall({worldBook:{view:{entries,raw:{token_budget:30}}},chat:{messages:[{role:'assistant',text:'少林山门',turn:1}]},userText:'请教少林罗汉功',turn:1})
 const excluded=result.diagnostics.find(e=>e.ref==='entry:0')
 assert.equal(excluded.reason,'budget');assert.equal(excluded.selectedBefore.length,5)
 assert.equal(excluded.match.primary[0].key,'少林')
 assert.equal(excluded.match.primary[0].source,'current-input')
 assert.match(excluded.match.primary[0].excerpt,/请教少林/)
 assert.equal(excluded.scanSources[1].turn,1)
 const secondary=result.diagnostics.find(e=>e.ref==='secondary')
 assert.equal(secondary.match.secondaryPassed,false)
 assert.deepEqual(secondary.match.secondaryKeys,['午夜'])
 assert.equal(secondary.reason,'keywords')
 assert.ok(excluded.priorityRank>result.diagnostics.find(e=>e.ref==='entry:5').priorityRank)
})
test('分组日志指明胜者与竞争方式，冷却日志记录起止依据', async () => {
 const entries=[entry('a',1,{group:'人',groupOverride:true}),entry('b',2,{group:'人'})]
 const first=prepareWorldBookRecall({worldBook:{view:{entries}},userText:'少林',turn:1})
 assert.equal(first.diagnostics.find(e=>e.ref==='b').groupReason,'priority')
 assert.deepEqual(first.diagnostics.find(e=>e.ref==='b').winners,['a'])
 const next=prepareWorldBookRecall({worldBook:{view:{entries}},userText:'少林',turn:2,chat:{worldBookReads:first.recordReads({})}})
 assert.deepEqual(next.diagnostics.find(e=>e.ref==='a').cooldown,{readTurn:1,currentTurn:2,duration:10})
})
test('日志把已选中但模板失败与实际输出分开，禁用条目有明确原因', async () => {
 const runtime=await UpstreamTemplateRuntime.create()
 const entries=[entry('bad',1,{content:'<% if ( %>'}),entry('good',2),entry('off',3,{enabled:false})]
 const project=createForegroundWorldbook({bound:async()=>({view:{entries}}),runtime:async()=>runtime,globalVariables:async()=>({})})
 const result=await project({chat:{messages:[]},card:{},userText:'少林'})
 assert.equal(result.log.entries.find(e=>e.ref==='bad').rendering,'syntax-error')
 assert.equal(result.log.entries.find(e=>e.ref==='bad').outputOrder,null)
 assert.equal(result.log.entries.find(e=>e.ref==='off').reason,'disabled')
 assert.deepEqual(result.log.outputs,[{ref:'good',text:'设定 good',location:'foreground'}])
 assert.deepEqual(result.refs,['good'])
 assert.equal(result.activation.diagnostics.find(e=>e.ref==='bad').match,undefined)
})
test('独立日志不覆盖同轮其他操作，关联实际 Frame 请求；不存在的旧轮次不伪造', async () => {
 const data=new Map();const clone=v=>v===undefined?undefined:structuredClone(v)
 const store={readJson:async p=>clone(data.get(p)),writeJson:async(p,v)=>data.set(p,clone(v)),updateJson:async(p,fn)=>data.set(p,clone(await fn(clone(data.get(p)))))}
 const logs=createWorldbookRecallLog({store,now:()=>100})
 const chat={id:'chat-1',sessionId:'test-1',timeline:{branchId:'branch-1'},foregroundFrames:{}}
 const frame={turn:2,operationId:'op-1',frameId:'frame-1',branchId:'branch-1',basedOnRevision:1,source:{worldBook:{}}}
 const log={entries:[],outputs:[{ref:'a',text:'实际正文',location:'foreground'}]}
 frame.source.worldBook.recallLog=await logs.record({chat,frame,log});chat.foregroundFrames[frame.operationId]=frame
 await logs.requested(chat,{messages:[{source:{form:'foreground-frame',trace:{frameId:'frame-1'}},content:[{type:'text',text:'前缀\n实际正文'}]}]},'request-1')
 const result=await logs.read(chat,2)
 assert.equal(result.log.status,'requested');assert.deepEqual(result.log.requestIds,['request-1'])
 assert.equal(result.log.outputs[0].requestContainsText,true)
 assert.equal((await logs.read(chat,1)).log,null)
 await logs.record({chat,frame:{...frame,operationId:'op-2'},log})
 assert.equal(data.get('worldbook-recalls/chat-1/index.json').records.length,2)
 assert.equal((await logs.read(chat,2)).log.operationId,'op-2')
 await assert.rejects(logs.record({chat:{...chat,id:'../escape'},frame,log}),/标识/)
})
