import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { createBackgroundSuppressionReader } from '../tavern-plugin/lib/domain/background-surface.js'

test('suppression reads use loaded evidence or bounded cached results without resuming agents',()=>{
 let scans=0, loaded=true, session={}
 const event={seq:0,get type(){scans++;return 'tool/call'},data:{turn:2}}
 const events=[event,{seq:1,type:'assistant/message',data:{message:{content:[]}},surfaceOp:{op:'replace',startSeq:0,endSeq:0}}]
 const read=createBackgroundSuppressionReader(()=>({loaded,session,events}))
 assert.deepEqual(read('background-a').turns,[2])
 const previous=scans
 read('background-a');assert.equal(scans,previous)
 events.push({seq:2,type:'tool/call',data:{turn:3}},{seq:3,type:'assistant/message',data:{message:{content:[]}},surfaceOp:{op:'replace',startSeq:2,endSeq:2}})
 assert.deepEqual(read('background-a').turns,[2,3])
 loaded=false
 const result=read('background-a');result.turns.push(99)
 assert.deepEqual(read('background-a').turns,[2,3])
 assert.deepEqual(read('background-cold'),{turns:[],loaded:false})
 loaded=true;session={};events.length=0
 assert.deepEqual(read('background-a').turns,[])
 assert.deepEqual(read('foreground'),{turns:[]})
})

test('RPC projection branch cannot resume or dispose a session',async()=>{
 const source=await readFile(new URL('../tavern-plugin/lib/index.js',import.meta.url),'utf8')
 const branch=source.split("case 'getBackgroundSuppressedTurns': {")[1].split("case 'applyUpdatedCard'")[0]
 assert.match(branch,/readBackgroundSuppression\(id\)/)
 assert.doesNotMatch(branch,/resume|dispose/)
})

test('slow polls do not overlap across subscriptions and idle polls stop after one result',async()=>{
 const source=await readFile(new URL('../tavern-plugin/src/client/background-suppression.js',import.meta.url),'utf8')
 const create=runInNewContext(source+';createBackgroundSuppressionPoller')
 let calls=0, resolve, id=0
 const timers=new Map()
 const poll=create(()=>{calls++;return new Promise(r=>{resolve=r})},{setTimeout(fn,ms){assert.equal(ms,15000);timers.set(++id,fn);return id},clearTimeout(id){timers.delete(id)}})
 const flush=()=>new Promise(r=>setImmediate(r))
 let results=0
 const stop=poll('background-a',true,()=>results++,assert.fail)
 await flush()
 assert.equal(calls,1);assert.equal(timers.size,0)
 stop()
 const stop2=poll('background-a',true,()=>results++,assert.fail)
 await flush();assert.equal(calls,1)
 resolve({turns:[1]});await flush()
 assert.equal(results,1);assert.equal(timers.size,1)
 stop2();assert.equal(timers.size,0)
 poll('background-a',false,()=>results++,assert.fail)
 await flush();assert.equal(calls,2)
 resolve({turns:[1]});await flush()
 assert.equal(results,2);assert.equal(timers.size,0)
})
