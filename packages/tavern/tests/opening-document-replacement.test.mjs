import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createServer} from 'node:http'
import vm from 'node:vm'
import test from 'node:test'
import {chromium} from 'playwright'
import {readTavernRuntimeAsset} from '../tavern-plugin/lib/domain/tavern-runtime-assets.js'

test('开局页面替换 document 后仍启动宿主模块并保留其 API', async t=>{
  let descriptor
  vm.runInNewContext(await readFile(new URL('../tavern-plugin/lib/client.js',import.meta.url),'utf8'),{window:{__ModuleLoader__:{load:d=>descriptor=d}},console})
  const client=descriptor.factory(()=>({}))
  const content=`<script>fetch('/wizard').then(r=>r.text()).then(html=>{document.open();document.write(html);document.close()})</script><script src="/parser-wait.js"></script>`
  const context={mvuEnabled:false,messages:[{message_id:0,role:'assistant',message:'opening',variables:{}}]}
  const html=client.buildTavernFrameDocument({content,openingPreview:{swipes:['opening'],openingIds:['first'],selectedIndex:0,preparationId:'test',runtime:{context,scripts:[{id:'wizard-runtime',content:'window.openingRuntimeStarts=(window.openingRuntimeStarts||0)+1;window.Mvu={getMvuData:()=>({stat_data:{name:"测试"}})};'}]}}})
  const server=createServer(async(req,res)=>{
    const p=new URL(req.url,'http://localhost').pathname
    if(p==='/wizard'){res.setHeader('content-type','text/html');res.end('<!doctype html><title>角色创建</title><button>开始旅程</button>');return}
    if(p==='/parser-wait.js'){await new Promise(r=>setTimeout(r,150));res.setHeader('content-type','text/javascript');res.end('');return}
    const asset=await readTavernRuntimeAsset(p)
    if(asset){res.setHeader('content-type',asset.mediaType);res.end(asset.body);return}
    res.setHeader('content-type','text/html');res.end(html)
  })
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)))
  const browser=await chromium.launch();t.after(()=>browser.close())
  const page=await browser.newPage()
  await page.goto('http://127.0.0.1:'+server.address().port)
  await page.getByRole('button',{name:'开始旅程'}).waitFor()
  await page.waitForFunction(()=>typeof window.Mvu?.getMvuData==='function',null,{timeout:3000})
  assert.equal(await page.evaluate(()=>window.Mvu.getMvuData().stat_data.name),'测试')
  assert.equal(await page.evaluate(()=>window.openingRuntimeStarts),1)
})
