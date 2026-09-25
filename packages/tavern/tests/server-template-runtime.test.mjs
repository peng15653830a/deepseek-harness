import test from 'node:test'
import assert from 'node:assert/strict'
import { createServerTemplateRuntime } from '../tavern-plugin/lib/domain/server-template-runtime.js'

function fixture(t, options = {}) {
  const snapshots = new Map(), calls = [], journals = new Map()
  function state(id) {
    if (!snapshots.has(id)) snapshots.set(id, {
      state: { sessionId: id, chatId: id, stateRevision: 0, lifecycleRevision: 0, chat: [], chat_metadata: { variables: {} } },
      environment: { name1: '你', name2: 'Test', this_chid: '0', characters: [{name:'Test',mes_example:'',description:'',personality:'',scenario:'',data:{name:'Test',extensions:{world:'book'}}}],
        extension_settings: { regex: [], variables: { global: {} }, EjsTemplate: { enabled: true } },
        world_names: ['book'], selected_world_info: [], worldbooks: { book: { entries: {} } }, dsh: { model: 'first', regexScripts: [] } }
    })
    return snapshots.get(id)
  }
  const runtime = createServerTemplateRuntime({ ...options, store: { readJson: async path => journals.get(path), writeJson: async (path, value) => journals.set(path, structuredClone(value)) }, rpc: async (method, args) => {
    calls.push({method,args:structuredClone(args)})
    await options.beforeRpc?.(method,args)
    const current = state(args.sessionId)
    if (method === 'getFullPromptTemplateState') return structuredClone(current)
    if (method === 'saveFullPromptTemplateSettings') { current.environment.extension_settings.EjsTemplate = structuredClone(args.settings); return {updated:true,settings:args.settings} }
    if (method === 'saveFullPromptTemplateGlobals') { current.environment.extension_settings.variables.global = structuredClone(args.variables); return {updated:true,variables:args.variables} }
    if (method === 'saveFullPromptTemplateState') { current.state=structuredClone(args.state); return {updated:true,state:args.state} }
    if (method === 'countFullTemplateTokens') return {tokens:args.text.length}
    throw Error(method)
  } })
  t.after(() => runtime.dispose())
  return { runtime, state, calls, journals, engine: runtime.forSession('s') }
}

test('runs actual upstream EJS without a webpage, including DOM and async compilation', async t => {
  const {engine,state,runtime} = fixture(t)
  state('s').environment.extension_settings.EjsTemplate.compile_workers = true
  const result = await engine.render('你好 <%= 1 + 2 %> <%= document.createElement("p").tagName %>')
  assert.equal(result.text, '你好 3 P')
  assert.equal((await runtime.inspect('s')).executor, 'node')
})

test('sessions isolate globals and serialize foreground/background operations', async t => {
  const {engine,runtime} = fixture(t)
  const results = await Promise.all([engine.render('<% window.counter = (window.counter || 0)+1 %><%= window.counter %>'), engine.render('<%= ++window.counter %>'), runtime.forSession('b').render('<%= typeof window.counter %>')])
  assert.deepEqual(results.map(r => r.text), ['1', '2', 'undefined'])
})

test('every entry refreshes external state and model, without caching evaluated output', async t => {
  const {engine,state} = fixture(t)
  assert.equal((await engine.render('<%= window.SillyTavern.getContext().dsh.model %>')).text, 'first')
  state('s').environment.dsh.model = 'second'
  assert.equal((await engine.render('<%= window.SillyTavern.getContext().dsh.model %>')).text, 'second')
  const results=await engine.renderProjections([{template:'<% window.n=0 %><%= ++window.n %>'},{template:'<%= ++window.n %>'}])
  assert.deepEqual(results.map(r=>r.text),['1','2'])
})

test('unchanged complete request retains system and message bytes/order', async t => {
  const {engine} = fixture(t)
  const request = {system:'stable system\n',messages:[{role:'user',content:'hello'}, {role:'assistant',content:'world'}, {role:'user',content:'next'}],model:'current'}
  const result=await engine.projectRequest(request)
  assert.equal(JSON.stringify(result), JSON.stringify({messages:request.messages,system:request.system}))
})

test('service watchdog terminates an infinite loop, does not replay, and next explicit call recovers', async t => {
  const {engine,runtime,journals} = fixture(t,{timeoutMs:1500})
  await engine.render('warm')
  await assert.rejects(engine.render('<% while(true){} %>'), /执行超时/)
  assert.equal((await runtime.inspect('s')).present,false)
  assert.equal([...journals.values()].at(-1).phase,'interrupted')
  assert.equal((await engine.render('recovered')).text,'recovered')
})

test('cancellation rejects running and queued work without replay', async t => {
  const {engine,runtime} = fixture(t)
  await engine.render('warm')
  const pending=Promise.allSettled([engine.render('<% await new Promise(r => setTimeout(r,30000)) %>'),engine.render('<% window.mustNotRun=true %>')])
  setTimeout(()=>runtime.cancel('s'),50)
  assert.deepEqual((await pending).map(r=>r.status),['rejected','rejected'])
  assert.equal((await engine.render('<%= typeof window.mustNotRun %>')).text,'undefined')
})

test('child cannot inherit host secret env or write arbitrary files', async t => {
  const {engine} = fixture(t)
  process.env.TAVERN_TEST_SECRET='do-not-inherit'
  t.after(()=>delete process.env.TAVERN_TEST_SECRET)
  // Host functions are deliberately probed: jsdom is not a security sandbox.
  const result=await engine.render('<%= structuredClone.constructor("return process")().env.TAVERN_TEST_SECRET || "absent" %>')
  assert.equal(result.text,'absent')
  const denied=await engine.render('<% const p=structuredClone.constructor("return process")(); const fs=p.getBuiltinModule("fs"); fs.writeFileSync("/tmp/template-escape-test","bad") %>')
  assert.equal(denied.ok,false)
  assert.match(denied.error,/Access to this API has been restricted|access denied/i)
})

test('display lifecycle evaluates messages and persists upstream display metadata', async t => {
  const {runtime,state}=fixture(t)
  state('s').state.chat=[{mes:'hello <%= 2+3 %>',name:'Test',is_user:false,is_system:false,variables:[{}],swipe_id:0,swipes:['hello <%= 2+3 %>']}]
  await runtime.synchronize('s')
  assert.ok(state('s').state.chat[0].template_rendered)
  assert.match(JSON.stringify(state('s').state.chat[0]),/hello 5/)
})

test('bounded process pool queues concurrent chats instead of failing the fifth chat', async t => {
  const {runtime}=fixture(t,{maxSessions:1})
  const results=await Promise.all(['a','b','c'].map(id=>runtime.forSession(id).render('<% await new Promise(r=>setTimeout(r,20)) %>'+id)))
  assert.deepEqual(results.map(r=>r.text),['a','b','c'])
})

test('setting changes are read on the next request without a browser settings event', async t => {
  const {engine,state}=fixture(t)
  assert.equal((await engine.projectRequest({messages:[{role:'user',content:'<%= 2+3 %>'}]})).messages[0].content,'5')
  state('s').environment.extension_settings.EjsTemplate.generate_enabled=false
  assert.equal((await engine.projectRequest({messages:[{role:'user',content:'<%= 2+3 %>'}]})).messages[0].content,'<%= 2+3 %>')
})

test('upstream optional compatibility sandbox still evaluates and reports syntax errors', async t => {
  const {engine,state}=fixture(t)
  state('s').environment.extension_settings.EjsTemplate.sandbox=true
  const result=await engine.render('沙箱 <%= 2+4 %>')
  assert.equal(result.text,'沙箱 6',result.error)
  assert.equal((await engine.render('<% const = %>')).ok,false)
})

test('cancellation drains an admitted save before a new explicit run can observe state',async t=>{
 let entered,release
 const enteredSave=new Promise(r=>{entered=r}),saveGate=new Promise(r=>{release=r})
 const {engine,runtime,state}=fixture(t,{beforeRpc:async method=>{if(method==='saveFullPromptTemplateGlobals'){entered();await saveGate}}})
 state('s').environment.extension_settings.EjsTemplate.autosave_enabled=true
 await engine.render('warm')
 const first=engine.command('/ejs <% setGlobalVar("saved",7) %>')
 const rejected=assert.rejects(first,/取消/)
 await enteredSave
 runtime.cancel('s')
 let completed=false
 const next=engine.render('<%= getGlobalVar("saved") %>').then(r=>{completed=true;return r})
 await new Promise(r=>setTimeout(r,25));assert.equal(completed,false)
 release();await rejected
 assert.equal((await next).text,'7')
})

test('JSON transport preserves seeded random evaluation while omitting host callbacks',async t=>{
 const {engine}=fixture(t)
 const context={random:()=>0,randomSeed:'stable',randomRef:'entry'}
 const first=await engine.renderProjection('<%= Math.random() %>',context)
 const second=await engine.renderProjection('<%= Math.random() %>',context)
 assert.equal(first.ok,true,first.error);assert.equal(first.text,second.text)
 assert.equal(first.randomCalls,1)
})

test('batch prepares each entry, isolates failed scopes, and returns compact receipts',async t=>{
 const {engine}=fixture(t)
 await engine.command('/ejs <% window.prepareCount=0; window.SillyTavern.getContext().eventSource.on("prompt_template_prepare",ctx=>{ctx.preparedMarker=++window.prepareCount}) %>')
 const results=await engine.renderProjections([
  {template:'<% setLocalVar("n",1) %><%= preparedMarker %>'},
  {template:'<% setLocalVar("n",999); throw Error("failed") %>'},
  {template:'<%= preparedMarker %>|<%= getLocalVar("n") %>'}
 ],{scopes:{global:{},local:{},message:{},initial:{}}})
 assert.equal(results[0].text,'1');assert.equal(results[1].ok,false);assert.equal(results[2].text,'3|1')
 assert.ok(results.every(result=>!Object.hasOwn(result,'scopes')))
})
