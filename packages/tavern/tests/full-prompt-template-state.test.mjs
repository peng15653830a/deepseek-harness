import { createPromptTemplateGlobalVariables } from '../tavern-plugin/lib/domain/prompt-template-global-variables.js'
import { createNativeTemplateConnection, reconcileTemplateReceipt } from '../tavern-plugin/lib/vendor/st-prompt-template/host-build/native-connection.js'
import { createProfileDataStore } from '../tavern-plugin/lib/profile-data-store.js'
import { createTavernExtensionSettings } from '../tavern-plugin/lib/domain/tavern-extension-settings.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createChatJournalStore } from '../tavern-plugin/lib/domain/chat-journal-store.js'
import { createChatPersistence } from '../tavern-plugin/lib/domain/chat-persistence.js'
import { createTavernScriptHostAdapter } from '../tavern-plugin/lib/domain/tavern-script-host-adapter.js'

async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'full-template-native-'))
  t.after(()=>rm(root,{recursive:true,force:true}))
  const open=()=>createChatPersistence({store:createChatJournalStore({dataRoot:root})})
  const persistence=open()
  await persistence.write({id:'chat',sessionId:'session',cardPath:'cards/test.json',mode:'story',mvu:{enabled:true},
    tavernHelperLifecycleRevision:1,variables:{local:1},messages:[{role:'assistant',text:'正文',sourceText:'正文',turn:1,
      variables:[{hp:10}],tavernPluginData:{unrelated:{keep:true}}}],tavernPluginMetadata:{other:true}})
  const adapter=createTavernScriptHostAdapter({resolveChat:()=>persistence.read('chat'),writeChat:persistence.write,
    updateChat:persistence.update,readChatRevision:persistence.readRevision,readCard:async()=>({name:'角色'}),
    worldBooks:{bound:async()=>null},scriptDispatch:{},isPlayChat:()=>true,
    globalVariables:createPromptTemplateGlobalVariables(createProfileDataStore({dataRoot:root})),
    fullExtensionSettings:createTavernExtensionSettings(createProfileDataStore({dataRoot:root}))})
  return {persistence,adapter,open}
}

test('完整模板宿主通过真实 journal 保存变量和处理标记，重开存储可恢复',async t=>{
  const {adapter,open}=await fixture(t)
  const {state,environment}=await adapter.readFullPromptTemplateState('session')
  assert.equal(environment.name2,'角色')
  state.chat[0].variables[0].hp=20
  state.chat[0].is_ejs_processed=[true]
  state.chat_metadata.variables.local=2
  const receipt=await adapter.saveFullPromptTemplateState('session',state)
  assert.equal(receipt.updated,true)
  assert.ok(receipt.state.stateRevision>state.stateRevision)
  const saved=await open().read('chat')
  assert.equal(saved.messages[0].variables[0].hp,20)
  assert.deepEqual(saved.messages[0].tavernPluginData,{unrelated:{keep:true},is_ejs_processed:[true]})
  assert.equal(saved.variables.local,2)
  assert.equal(saved.tavernPluginMetadata.other,true)
  assert.equal(saved.messages[0].sourceText,'正文')
})

test('模板保存保留并发的其他变量；同一变量冲突时拒绝整次写入',async t=>{
  const {adapter,persistence}=await fixture(t)
  const {state}=await adapter.readFullPromptTemplateState('session')
  await persistence.update('chat',chat=>{chat.variables.other=7;chat.messages[0].variables[0].other=8;return chat})
  state.chat_metadata.variables.local=2;state.chat[0].variables[0].hp=11
  await adapter.saveFullPromptTemplateState('session',state)
  const saved=await persistence.read('chat')
  assert.deepEqual(saved.variables,{local:2,other:7})
  assert.deepEqual(saved.messages[0].variables[0],{hp:11,other:8})
  state.chat[0].variables[0].hp=12
  const before=await persistence.read('chat')
  await assert.rejects(adapter.saveFullPromptTemplateState('session',state),error=>error.code==='PROMPT_TEMPLATE_STATE_CONFLICT')
  assert.deepEqual(await persistence.read('chat'),before)
})

test('回退或正文替换后的旧模板保存被拒绝，不影响新的剧情和变量',async t=>{
  const {adapter,persistence}=await fixture(t)
  const {state}=await adapter.readFullPromptTemplateState('session')
  state.chat[0].variables[0].hp=99
  await persistence.update('chat',chat=>{chat.tavernHelperLifecycleRevision++;chat.messages[0].text='新正文';return chat})
  const before=await persistence.read('chat')
  await assert.rejects(adapter.saveFullPromptTemplateState('session',state),/已过期|已切换/)
  assert.deepEqual(await persistence.read('chat'),before)
})

test('变量存档不能夹带聊天正文修改，失败时其他变量也不落盘',async t=>{
  const {adapter,persistence}=await fixture(t)
  const {state}=await adapter.readFullPromptTemplateState('session')
  state.chat[0].variables[0].hp=99;state.chat[0].mes='伪造正文'
  const before=await persistence.read('chat')
  await assert.rejects(adapter.saveFullPromptTemplateState('session',state),error=>error.code==='PROMPT_TEMPLATE_HISTORY_UNSUPPORTED')
  assert.deepEqual(await persistence.read('chat'),before)
})


test('浏览器连接使用实际宿主接口保存设置与变量，回执推进读取版本',async t=>{
  const {adapter,open}=await fixture(t)
  const rpc=async(method,args)=>{
    if(method==='saveFullPromptTemplateGlobals') return adapter.saveFullPromptTemplateGlobals(args.sessionId,args.variables,args.expectedVariables)
    if(method==='getFullPromptTemplateState') return adapter.readFullPromptTemplateState(args.sessionId)
    if(method==='saveFullPromptTemplateState') return adapter.saveFullPromptTemplateState(args.sessionId,args.state)
    if(method==='saveFullPromptTemplateSettings') return adapter.saveFullPromptTemplateSettings(args.sessionId,args.settings,args.expectedSettings)
    throw new Error('unexpected method')
  }
  const connection=await createNativeTemplateConnection({sessionId:'session',rpc,settingsHtml:'<div></div>',services:{onPersistenceError(){}}})
  const state=connection.snapshot
  state.extension_settings.EjsTemplate={enabled:false,generate_enabled:true}
  await connection.callbacks.saveSettingsDebounced(state.extension_settings)
  state.chat[0].variables[0].hp=12
  await connection.callbacks.saveChatConditional(state)
  state.chat[0].variables[0].hp=13
  await connection.callbacks.saveChatConditional(state)
  assert.equal((await open().read('chat')).messages[0].variables[0].hp,13)
  const reread=await adapter.readFullPromptTemplateState('session')
  assert.equal(reread.environment.extension_settings.EjsTemplate.enabled,false)
  state.extension_settings.variables.global.LAST_SEND_TOKENS=165
  await connection.callbacks.saveSettingsDebounced(state.extension_settings)
  state.extension_settings.variables.global.LAST_SEND_TOKENS=166
  await connection.callbacks.saveChatConditional(state)
  assert.equal((await adapter.readFullPromptTemplateState('session')).environment.extension_settings.variables.global.LAST_SEND_TOKENS,166)
})

test('保存回执保留等待期间的新编辑，合入服务器上的无关更新',()=>{
  const submitted={variables:{hp:1,mp:2},flags:[true,false]}
  const current={variables:{hp:3,mp:2},flags:[true,false]}
  const saved={variables:{hp:1,mp:4,other:7},flags:[true]}
  const held=current.variables
  reconcileTemplateReceipt(current,submitted,saved)
  assert.equal(current.variables,held)
  assert.deepEqual(current,{variables:{hp:3,mp:4,other:7},flags:[true]})
})


test('纯 EJS 人物卡无需启用 MVU 或配套脚本即可读取和保存模板状态',async t=>{
  const {adapter,persistence}=await fixture(t)
  await persistence.update('chat',chat=>{chat.mvu.enabled=false;return chat})
  const {state}=await adapter.readFullPromptTemplateState('session')
  state.chat_metadata.variables.local=3
  await adapter.saveFullPromptTemplateState('session',state)
  assert.equal((await persistence.read('chat')).variables.local,3)
})
