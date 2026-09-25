import test from 'node:test'
import assert from 'node:assert/strict'
import { createFullPromptTemplateSync } from '../tavern-plugin/lib/domain/full-prompt-template-sync.js'
import { applyTemplateSync } from '../tavern-plugin/lib/vendor/st-prompt-template/host-build/native-connection.js'

test('1800 条长历史只传变化楼层，删除和环境变化与全量结果一致', () => {
  const sync=createFullPromptTemplateSync()
  let state={state:{chatId:'c',sessionId:'s',stateRevision:1,chat_metadata:{variables:{}},chat:Array.from({length:1800},(_,i)=>({mes:i+':'+ '历史'.repeat(1000),variables:[{hp:7}]}))},environment:{worldbooks:{large:'设定'.repeat(10000)},extension_settings:{enabled:true},name1:'玩家'}}
  let received=sync(state)
  const fullBytes=JSON.stringify(received).length
  state=structuredClone(state)
  state.state.chat.push({mes:'新消息',variables:[{hp:6}]});state.state.stateRevision++
  let delta=sync(state,received.cursor)
  assert.equal(delta.delta.chat.set.length,1)
  assert.ok(JSON.stringify(delta).length < fullBytes/100)
  received=applyTemplateSync(received,delta)
  assert.deepEqual(received.state,state.state)
  state.state.chat[5].mes='编辑历史';state.state.chat.length=100;state.state.stateRevision++
  delete state.environment.name1
  state.environment.extension_settings.enabled=false
  delta=sync(state,received.cursor);received=applyTemplateSync(received,delta)
  assert.deepEqual(received.state,state.state)
  assert.deepEqual(received.environment,state.environment)
  assert.equal(delta.delta.chat.set.length,1)
  assert.throws(()=>applyTemplateSync({...received,cursor:'wrong'},delta),/cursor mismatch/)
  const reset=sync({...state,state:{...state.state,chatId:'other'}},received.cursor)
  assert.ok(reset.state)
})

test('空增量刷新不序列化历史，且仍能撤销上游未保存的本地改动', async t => {
  const {createNativeTemplateConnection}=await import('../tavern-plugin/lib/vendor/st-prompt-template/host-build/native-connection.js')
  const snapshot={cursor:'a',state:{chat:[{mes:'历史'.repeat(10000),variables:[{hp:7}]}],chat_metadata:{variables:{}}},environment:{extension_settings:{EjsTemplate:{},variables:{global:{}}}}}
  let first=true
  const connection=await createNativeTemplateConnection({sessionId:'s',rpc:async()=>first?(first=false,structuredClone(snapshot)):{cursor:'a',baseCursor:'a',delta:{chat:{length:1,set:[]},state:{set:{},remove:[]},environment:{set:{},remove:[]}}}})
  const stringify=JSON.stringify;let calls=0
  t.mock.method(JSON,'stringify',(...args)=>{calls++;return stringify(...args)})
  await connection.refresh()
  assert.equal(calls,0,'空增量不应把历史转成 JSON 再比较')
  connection.snapshot.chat[0].variables[0].hp=99
  await connection.refresh()
  assert.equal(connection.snapshot.chat[0].variables[0].hp,7)
})


test('同一权威版本跳过整段历史指纹计算，独立环境变化仍同步',t=>{
  const sync=createFullPromptTemplateSync()
  const snapshot={state:{chatId:'c',sessionId:'s',stateRevision:1,chat:[{mes:'历史正文',variables:[{}]}]},environment:{settings:{n:1}}}
  const first=sync(snapshot)
  const stringify=JSON.stringify;let historyReads=0
  t.mock.method(JSON,'stringify',(value,...args)=>{if(value?.mes==='历史正文')historyReads++;return stringify(value,...args)})
  snapshot.environment.settings.n=2
  const delta=sync(snapshot,first.cursor)
  assert.equal(historyReads,0)
  assert.deepEqual(delta.delta.chat.set,[])
  assert.equal(delta.delta.environment.set.settings.n,2)
})

test('selected projection fingerprints only changed rows and rejects consumed or stale cursors',()=>{
 const sync=createFullPromptTemplateSync()
 const first=sync({state:{chatId:'c',sessionId:'s',stateRevision:1,lifecycleRevision:0,chat:[{mes:'old'},{mes:'two'}]},environment:{}})
 const snapshot={state:{chatId:'c',sessionId:'s',stateRevision:2,lifecycleRevision:0,chat:[{mes:'new'}]},environment:{}}
 assert.equal(sync.selected(snapshot,first.cursor,[1],2,0),undefined)
 const result=sync.selected(snapshot,first.cursor,[1],2,1)
 assert.deepEqual(applyTemplateSync(first,result).state.chat,[{mes:'old'},{mes:'new'}])
 assert.equal(sync.selected(snapshot,first.cursor,[1],2,1),undefined)
 assert.equal(sync.selected({...snapshot,state:{...snapshot.state,lifecycleRevision:1}},result.cursor,[1],2,2),undefined)
})

test('不可变环境快照只算一次指纹，发给调用者的内容仍是独立副本', async t => {
  const { freezeJsonProjection } = await import('../tavern-plugin/lib/domain/immutable-json-projection.js')
  const sync = createFullPromptTemplateSync()
  const worldbooks = freezeJsonProjection({ A: { entries: { 0: { content: 'original' } } } })
  const snapshot = { state: { chatId: 'c', sessionId: 's', stateRevision: 1, chat: [] }, environment: { worldbooks } }
  const stringify = JSON.stringify; let reads = 0
  t.mock.method(JSON, 'stringify', (value, ...args) => { if (value === worldbooks) reads++; return stringify(value, ...args) })
  const first = sync(snapshot)
  first.environment.worldbooks.A.entries[0].content = 'caller mutation'
  assert.equal(worldbooks.A.entries[0].content, 'original')
  const second = sync(snapshot, first.cursor)
  assert.equal(reads, 1)
  assert.deepEqual(second.delta.environment.set, {})
  const changed = freezeJsonProjection({ A: { entries: { 0: { content: 'changed' } } } })
  snapshot.environment.worldbooks = changed
  const third = sync(snapshot, second.cursor)
  third.delta.environment.set.worldbooks.A.entries[0].content = 'another caller mutation'
  assert.equal(changed.A.entries[0].content, 'changed')
  // Shallow freezing an arbitrary object is not proof of immutability.
  const mutable = Object.freeze({ nested: { n: 1 } })
  snapshot.environment.other = mutable
  const fourth = sync(snapshot, third.cursor)
  mutable.nested.n = 2
  const fifth = sync(snapshot, fourth.cursor)
  assert.equal(fifth.delta.environment.set.other.nested.n, 2)
})
