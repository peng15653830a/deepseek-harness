import test from 'node:test'
import assert from 'node:assert/strict'
import {setTimeout as delay} from 'node:timers/promises'
import {createServerTemplateSync} from '../tavern-plugin/lib/domain/server-template-sync.js'
test('a revision arriving during display work runs once after current work drains',async t=>{
 let release,started,runs=0
 const entered=new Promise(r=>started=r),gate=new Promise(r=>release=r)
 const sync=createServerTemplateSync({delayMs:1,run:async()=>{runs++;if(runs===1){started();await gate}}})
 t.after(()=>sync.dispose());sync.schedule('s',1)
 // Keep the test process alive while the production scheduler's unref timer runs.
 await Promise.all([entered,delay(10)])
 sync.schedule('s',2);sync.schedule('s',2)
 release();await delay(20)
 assert.equal(runs,2)
 sync.schedule('s',2);await delay(10);assert.equal(runs,2)
})
test('failed display work is not retried on repeated reads of the same revision',async t=>{
 let runs=0,errors=0
 const sync=createServerTemplateSync({delayMs:1,run:async()=>{runs++;throw Error('template failed')},onError:()=>errors++})
 t.after(()=>sync.dispose());sync.schedule('s',1);await delay(10)
 sync.schedule('s',1);await delay(10);assert.equal(runs,1);assert.equal(errors,1)
 sync.schedule('s',2);await delay(10);assert.equal(runs,2)
})
test('deferred settlement work retries, disposal cancels pending timers',async()=>{
 let runs=0
 const sync=createServerTemplateSync({delayMs:1,run:async()=>({deferred:++runs===1})})
 sync.schedule('s',1);await delay(20);assert.equal(runs,2)
 sync.schedule('s',2);sync.dispose();await delay(10);assert.equal(runs,2)
})
