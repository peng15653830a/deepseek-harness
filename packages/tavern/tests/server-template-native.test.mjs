import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createServerTemplateRuntime} from '../tavern-plugin/lib/domain/server-template-runtime.js'
import {createChatJournalStore} from '../tavern-plugin/lib/domain/chat-journal-store.js'
import {createChatPersistence} from '../tavern-plugin/lib/domain/chat-persistence.js'
import {createProfileDataStore} from '../tavern-plugin/lib/profile-data-store.js'
import {createTavernExtensionSettings} from '../tavern-plugin/lib/domain/tavern-extension-settings.js'
import {createPromptTemplateGlobalVariables} from '../tavern-plugin/lib/domain/prompt-template-global-variables.js'
import {createTavernScriptHostAdapter} from '../tavern-plugin/lib/domain/tavern-script-host-adapter.js'

test('server engine uses real journal, delta snapshots, persistent variable writes and external changes',async t=>{
 const root=await mkdtemp(join(tmpdir(),'server-template-native-'))
 t.after(()=>rm(root,{recursive:true,force:true}))
 const open=()=>createChatPersistence({store:createChatJournalStore({dataRoot:root})})
 const persistence=open(),store=createProfileDataStore({dataRoot:root})
 await persistence.write({id:'chat',sessionId:'s',cardPath:'cards/test.json',mode:'story',variables:{},messages:[{role:'assistant',text:'Opening',variables:[{hp:7}]}]})
 await createTavernExtensionSettings(store).save({EjsTemplate:{enabled:true,autosave_enabled:true}}, {})
 const globals=createPromptTemplateGlobalVariables(store)
 let model='first'
 const adapter=createTavernScriptHostAdapter({resolveChat:()=>persistence.read('chat'),writeChat:persistence.write,updateChat:persistence.update,readChatRevision:persistence.readRevision,
 readCard:async()=>({name:'Alice',mes_example:'',description:'',personality:'',scenario:''}),scriptDispatch:{},globalVariables:globals,fullExtensionSettings:createTavernExtensionSettings(store),modelFor:()=>model,
 worldBooks:{bound:async()=>({source:{kind:'standalone',path:'book'},view:{displayName:'book'}}),export:async()=>({document:{entries:{0:{uid:0,comment:'Guide',key:[],constant:true,content:'HP <%= getMessageVar("hp") %>',position:0,order:100}}}})}})
 const sync=[]
 const runtime=createServerTemplateRuntime({store,rpc:async(method,args)=>{
  if(method==='getFullPromptTemplateState'){const result=await adapter.readFullPromptTemplateState(args.sessionId,args.cursor);sync.push(result.delta?'delta':'full');return result}
  if(method==='saveFullPromptTemplateSettings')return adapter.saveFullPromptTemplateSettings(args.sessionId,args.settings,args.expectedSettings)
  if(method==='saveFullPromptTemplateState')return adapter.saveFullPromptTemplateState(args.sessionId,args.state)
  if(method==='saveFullPromptTemplateGlobals')return adapter.saveFullPromptTemplateGlobals(args.sessionId,args.variables,args.expectedVariables)
  if(method==='countFullTemplateTokens')return {tokens:args.text.length}
  throw Error(method)
 }})
 t.after(()=>runtime.dispose())
 const engine=runtime.forSession('s')
 assert.equal((await engine.render('<%= charName %>:<%= getMessageVar("hp") %>')).text,'Alice:7')
 await engine.command('/ejs <% setMessageVar("hp",9) %>')
 assert.equal((await open().read('chat')).messages[0].variables[0].hp,9)
 const result=await engine.projectRequest({system:'fixed system',messages:[{role:'user',content:'<%- await getWorldInfo("Guide") %>'}],model:'selected'})
 assert.equal(result.messages[0].content,'HP 9')
 assert.equal(result.system,'fixed system')
 await createPromptTemplateGlobalVariables(createProfileDataStore({dataRoot:root})).save({weather:'rain'})
 model='second'
 assert.equal((await engine.render('<%= getGlobalVar("weather") %>|<%= window.SillyTavern.getContext().dsh.model %>')).text,'rain|second')
 assert.equal(sync[0],'full');assert.ok(sync.slice(1).every(mode=>mode==='delta'))
 await runtime.synchronize('s')
 assert.ok((await open().read('chat')).messages[0].tavernPluginData.template_rendered)
})
