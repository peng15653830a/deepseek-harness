import { createPromptTemplateGlobalVariables } from '../../tavern-plugin/lib/domain/prompt-template-global-variables.js'
import { createServer } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createChatJournalStore } from '../../tavern-plugin/lib/domain/chat-journal-store.js'
import { createChatPersistence } from '../../tavern-plugin/lib/domain/chat-persistence.js'
import { createProfileDataStore } from '../../tavern-plugin/lib/profile-data-store.js'
import { createTavernExtensionSettings } from '../../tavern-plugin/lib/domain/tavern-extension-settings.js'
import { createTavernScriptHostAdapter } from '../../tavern-plugin/lib/domain/tavern-script-host-adapter.js'
import { createFullPromptTemplateAssetReader, FULL_PROMPT_TEMPLATE_ASSET_PREFIX } from '../../tavern-plugin/lib/domain/full-prompt-template-assets.js'
import { readTavernRuntimeAsset, TAVERN_RUNTIME_ASSET_PREFIX } from '../../tavern-plugin/lib/domain/tavern-runtime-assets.js'
const root=await mkdtemp(join(tmpdir(),'full-template-browser-native-'))
const open=()=>createChatPersistence({store:createChatJournalStore({dataRoot:root})})
const persistence=open()
await persistence.write({id:'test-chat',sessionId:'test-session',cardPath:'cards/test.json',mode:'story',mvu:{enabled:true},
  variables:{},messages:[{role:'assistant',text:'Opening',variables:[{hp:7}]}]})
const adapter=createTavernScriptHostAdapter({resolveChat:()=>persistence.read('test-chat'),writeChat:persistence.write,
 updateChat:persistence.update,readChatRevision:persistence.readRevision,readCard:async()=>({name:'Alice'}),scriptDispatch:{},
 globalVariables:createPromptTemplateGlobalVariables(createProfileDataStore({dataRoot:root})),
    fullExtensionSettings:createTavernExtensionSettings(createProfileDataStore({dataRoot:root})),
 worldBooks:{bound:async()=>({source:{kind:'standalone',path:'book'},view:{displayName:'book'}}),
 export:async()=>({document:{entries:{0:{uid:0,comment:'Guide',key:[],constant:true,content:'HP <%= getMessageVar("hp") %>',position:0,order:100}}}})}
})
const asset= createFullPromptTemplateAssetReader({directory:pathToFileURL(resolve(process.argv[2] || '/tmp/dsh-template-production-assets')+'/')})
const html=`<!doctype html><meta charset="utf-8"><title>Native full template smoke</title><link rel="icon" href="data:,">
<script src="${TAVERN_RUNTIME_ASSET_PREFIX}jquery/jquery.min.js"></script><script src="${TAVERN_RUNTIME_ASSET_PREFIX}lodash/lodash.min.js"></script>
<div id="extensions_settings"></div><pre id="result">Starting</pre>
<script type="module">
import * as YAML from '${TAVERN_RUNTIME_ASSET_PREFIX}yaml/index.mjs';
import {connectTemplateSession} from '${FULL_PROMPT_TEMPLATE_ASSET_PREFIX}index.js';
const output=document.querySelector('#result');
window.addEventListener('unhandledrejection',e=>{window.smoke={ok:false,error:String(e.reason)};output.textContent=JSON.stringify(window.smoke)});
const rpc=async(method,args)=>{const r=await fetch('/api/'+method,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(args)});const result=await r.json();if(!r.ok)throw new Error(result.error);return result};
const assert=(v,label)=>{if(!v)throw new Error(label)};
window.toastr=Object.fromEntries(['info','success','warning','error'].map(k=>[k,message=>console.log(k,message)]));
let context;window.SillyTavern={getContext:()=>context};
try {
 const settingsHtml=await fetch('${FULL_PROMPT_TEMPLATE_ASSET_PREFIX}settings.html').then(r=>r.text());
 const plugin=await connectTemplateSession({sessionId:'test-session',rpc,settingsHtml,libraries:{yaml:YAML},services:{
   getUserAvatar:()=>'',getThumbnailUrl:()=>'',getCharaFilename:()=> 'alice',getChatCompletionModel:()=> 'fixture-model',
   substituteParams:value=>String(value),getRegexedString:value=>value,getTokenCountAsync:async value=>Array.from(String(value)).length
 }});
 context=plugin.context;window.plugin=plugin;
 const first=await plugin.api.evalTemplate('<%= charName %>:<%= getMessageVar("hp") %>');assert(first==='Alice:7','initial template');
 await plugin.command('ejs',{},'<% setMessageVar("hp", 9) %>');await plugin.api.saveVariables(true);
 const request=await plugin.processChatCompletion({messages:[{role:'user',content:'<%- await getWorldInfo("Guide") %>'}]});
 assert(request.messages[0].content==='HP 9','native request template');
 const persisted=await fetch('/persisted').then(r=>r.json());assert(persisted.hp===9,'journal did not persist');
 window.smoke={ok:true,first,request:request.messages[0].content,persisted};output.textContent=JSON.stringify(window.smoke);
}catch(error){window.smoke={ok:false,error:String(error.stack||error)};output.textContent=JSON.stringify(window.smoke)}
</script>`
const server=createServer(async(req,res)=>{
 try {
  const path=new URL(req.url,'http://localhost').pathname
  if(path==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(html);return}
  if(path==='/persisted'){const state=await open().read('test-chat');res.setHeader('Content-Type','application/json');res.end(JSON.stringify({hp:state.messages[0].variables[0].hp,revision:state._storageRevision,globalVariables:await createPromptTemplateGlobalVariables(createProfileDataStore({dataRoot:root})).read()}));return}
  if(path.startsWith('/api/')) {
   if(path.startsWith(FULL_PROMPT_TEMPLATE_ASSET_PREFIX) || path.startsWith(TAVERN_RUNTIME_ASSET_PREFIX)) {
    const file=path.startsWith(FULL_PROMPT_TEMPLATE_ASSET_PREFIX)?await asset(path):await readTavernRuntimeAsset(path)
    if(!file){res.writeHead(404);res.end();return}res.writeHead(200,{'Content-Type':file.mediaType});res.end(file.body);return
   }
   let raw='';for await(const chunk of req)raw+=chunk
   const args=JSON.parse(raw),name=path.slice(5)
   let result
   if(name==='saveFullPromptTemplateGlobals') result=await adapter.saveFullPromptTemplateGlobals(args.sessionId,args.variables,args.expectedVariables)
   else if(name==='getFullPromptTemplateState') result=await adapter.readFullPromptTemplateState(args.sessionId)
   else if(name==='saveFullPromptTemplateState') result=await adapter.saveFullPromptTemplateState(args.sessionId,args.state)
   else if(name==='saveFullPromptTemplateSettings') result=await adapter.saveFullPromptTemplateSettings(args.sessionId,args.settings,args.expectedSettings)
   else throw new Error('Unknown method')
   res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));return
  }
  res.writeHead(404);res.end()
 }catch(error){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:String(error.message)}))}
})
server.listen(0,'127.0.0.1',()=>console.log('http://127.0.0.1:'+server.address().port))
