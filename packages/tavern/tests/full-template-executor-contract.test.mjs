import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
const source = await readFile(new URL('../tavern-plugin/src/client/full-template-executor.js', import.meta.url), 'utf8')
test('opening initialization calls the server directly and never creates an iframe', async () => {
  const calls=[]
  const scope=vm.createContext({rpc:async(...args)=>{calls.push(args);return {runtime:{ready:true}}}})
  vm.runInContext(source,scope)
  const response={preparationId:'draft',openings:[{openingPreview:{}}]}
  assert.equal(await scope.initializeFullOpeningTemplate(response),response)
  assert.deepEqual(calls.map(c=>[c[0],c[2]]),[['initializeOpeningTemplate','opening:draft']])
  assert.equal(response.openings[0].openingPreview.runtime.ready,true)
})
test('navigation owns only a settings listener, no template execution or heartbeat',()=>{
  const events=new Map(),calls=[]
  const scope=vm.createContext({isPlayMode:()=>true})
  vm.runInContext(source,scope)
  const panel=scope.createServerTemplatePanel({window:{addEventListener:(k,v)=>events.set(k,v),removeEventListener:k=>events.delete(k)},rpc:(...args)=>calls.push(args)})
  panel.sync('a',{chatId:'a'});panel.sync('b',{chatId:'b'});panel.dispose()
  assert.equal(events.size,0);assert.deepEqual(calls,[])
})
