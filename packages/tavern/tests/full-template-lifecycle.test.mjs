import assert from 'node:assert/strict'
import test from 'node:test'
import { UpstreamTemplateRuntime } from './fixtures/upstream-template-runtime.mjs'
import { projectReplyHistory } from '../tavern-plugin/lib/domain/reply-presentation.js'
import { projectPersistentStatusView } from '../tavern-plugin/lib/domain/persistent-status-view.js'
const runtime = await UpstreamTemplateRuntime.create()

test('浏览器规范化状态占位标签不应生成覆盖正则的显示快照', async () => {
  const source = '开场正文\n<StatusPlaceHolderImpl/>'
  const result = await runtime.lifecycle({settings:{preload_worldinfo_enabled:false},transcript:[{role:'assistant',content:source}]})
  for (const state of [result.first, result.second]) {
    assert.equal(state.chat[0].mes, source)
    assert.equal(state.chat[0].template_display, undefined)
    const messages = [{role:'assistant',turn:1,text:source,sourceText:source,tavernPluginData:state.chat[0]}]
    const regexScripts = [{enabled:true,placement:[2],markdownOnly:true,findRegex:'/<StatusPlaceHolderImpl\\s*\\/>/g',replaceString:'<html><body><script>loadStatus()</script></body></html>'}]
    const history = projectReplyHistory(messages, {regexScripts})
    assert.ok(projectPersistentStatusView(messages, history.projections, {regexScripts}).statusView)
  }
})

test('官方永久渲染写入正文，刷新快照不会再次运行变量副作用', async () => {
  const result = await runtime.lifecycle({settings:{preload_worldinfo_enabled:false},transcript:[{role:'assistant',content:'<% setMessageVar("count", (getMessageVar("count") || 0) + 1) %>值 <%= getMessageVar("count") %>'}]})
  assert.equal(result.first.chat[0].mes,'值 1')
  assert.equal(result.first.chat[0].variables[0].count,1)
  assert.deepEqual(result.second.chat,result.first.chat)
})

test('官方 render_before/render_after 渲染用户与回复，显示内容不污染正文', async () => {
  const result = await runtime.lifecycle({settings:{preload_worldinfo_enabled:false,raw_message_evaluation_enabled:false},transcript:[{role:'user',content:'玩家动作'},{role:'assistant',content:'角色回复'}],worldBookEntries:[
    {uid:1001,comment:'[render] Before',enabled:false,constant:true,content:'@@render_before\n前缀'},
    {uid:1002,comment:'[render] After',enabled:false,constant:true,content:'@@render_after\n后缀'}]})
  assert.equal(result.first.chat[0].mes,'玩家动作')
  assert.equal(result.first.chat[1].mes,'角色回复')
  for(const message of result.first.chat) {
    assert.match(message.template_display.html,/前缀/)
    assert.match(message.template_display.html,/后缀/)
  }
})

test('官方命令接受上下文 JSON，保留代码中的空格与逻辑运算', async () => {
  const result=await runtime.command('/ejs ctx={"x": 3} block=true x || 7')
  assert.equal(result.pipe,'3')
})

test('官方世界书加载事件过滤条件和专用条目，预处理正文及关键词', async () => {
  const entries=[
    {uid:1201,comment:'hidden',disable:false,content:'@@if false\n不能注入'},
    {uid:1202,comment:'render',disable:true,content:'@@render_before\n显示专用'},
    {uid:1203,comment:'prepare',disable:false,content:'@@preprocessing\n值 <%= 1+2 %>',key:['<%= "角色" %>'],keysecondary:[]}
  ]
  const result=await runtime.prepareWorldbook(entries)
  assert.deepEqual(result.entries.map(e=>e.uid),[1203])
  assert.equal(result.entries[0].content,'值 3')
  // Pinned upstream evalTemplateWI currently evaluates content for each key too.
  assert.deepEqual(result.entries[0].key,['值 3'])
})

test('上游设置与 Monaco 编辑器实际加载，保存/取消与条目保存使用同一实例', async () => {
  await runtime.panel({worldBookEntries:[{uid:1301,comment:'编辑样例',content:'原文 <%= 1 %>'}]})
  const page=runtime.page
  const listeners=await page.evaluate(()=>window.testHost.eventSource.count())
  await page.locator('#pt_code_editor').check()
  // Upstream lazy loader registers APP_READY only after Monaco is ready.
  await page.waitForFunction(count=>window.testHost.eventSource.count()>count, listeners, {timeout:20000})
  await page.getByRole('button',{name:'展开编辑',exact:true}).click()
  await page.getByRole('button',{name:'Monaco 编辑',exact:true}).waitFor({state:'visible',timeout:20000})
  await page.getByRole('button',{name:'Monaco 编辑',exact:true}).click()
  await page.locator('.monaco-editor').waitFor({state:'visible'})
  await page.locator('.monaco-editor .view-lines').click()
  await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.type('取消内容')
  await page.getByRole('button',{name:'取消',exact:true}).click()
  assert.equal(await page.getByRole('textbox',{name:'条目正文',exact:true}).inputValue(),'原文 <%= 1 %>')
  await page.getByRole('button',{name:'Monaco 编辑',exact:true}).click()
  await page.locator('.monaco-editor .view-lines').click()
  await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.insertText('已保存的模板正文')
  await page.getByRole('button',{name:'Save',exact:true}).click()
  assert.equal(await page.getByRole('textbox',{name:'条目正文',exact:true}).inputValue(),'已保存的模板正文')
  await page.getByRole('button',{name:'保存条目',exact:true}).click()
  await page.getByRole('status').filter({hasText:'已保存'}).waitFor()
})

test('玩家输入在召回前执行官方渲染，返回新变量且不提前提交一个聊天楼层', async () => {
  const result = await runtime.renderInput('<% setMessageVar("place", "少林") %>进入<%= getMessageVar("place") %>', {settings:{raw_message_evaluation_enabled:true},transcript:[{role:'assistant',content:'开场',variables:[{hp:7}]}],scopes:{global:{},local:{},initial:{},message:{hp:7}}})
  assert.equal(result.message.mes,'进入少林')
  assert.deepEqual(result.message.variables[0],{hp:7,place:'少林'})
  assert.equal(result.message.is_ejs_processed[0],true)
  assert.equal(result.scopes.message.place,'少林')
})

test('显示脚本在真正展示的 frame 执行一次，格式化镜像不执行脚本或事件属性', async () => {
  const content='<p>正文</p><script>window.__visibleCount=(window.__visibleCount||0)+1</script><img src="data:image/png,broken" onerror="window.__imageFired=true">正文'
  const result=await runtime.lifecycle({settings:{preload_worldinfo_enabled:false,raw_message_evaluation_enabled:true},transcript:[{role:'assistant',content}],worldBookEntries:[{uid:1401,comment:'render',constant:true,enabled:false,content:'@@render_before\n前缀'}]})
  const page=runtime.page
  await page.waitForFunction(()=>document.querySelector('#chat img')?.complete)
  assert.equal(await page.evaluate(()=>window.__visibleCount),undefined)
  assert.equal(await page.evaluate(()=>window.__imageFired),undefined)
  const html=result.first.chat[0].template_display.html
  assert.match(html,/onerror=/)
  await page.evaluate(html=>{const frame=document.createElement('iframe');frame.id='visible-test';frame.srcdoc=html;document.body.append(frame)},html)
  await page.waitForFunction(()=>document.querySelector('#visible-test')?.contentWindow.__imageFired===true)
  assert.equal(await page.evaluate(()=>document.querySelector('#visible-test').contentWindow.__visibleCount),1)
  await page.locator('#visible-test').evaluate(frame=>frame.remove())
})


test('上游可选 Worker 编译使用本地完整 EJS，正常结果与语法错误均返回', async () => {
  const context={settings:{compile_workers:true,preload_worldinfo_enabled:false}}
  const result=await runtime.render('值 <%= _.keyBy([{id:"a",n:7}],"id").a.n %>',context)
  assert.equal(result.text,'值 7')
  const invalid=await runtime.render('<% const = %>',context)
  assert.equal(invalid.ok,false)
  await runtime.render('恢复',{settings:{compile_workers:false}})
})


test('新轮次、全局变量与设置变化保留旧展示；编辑只更新对应楼层，回退恢复快照', async () => {
  const source='当时的值 <%= getGlobalVar("hp") %>'
  const states=await runtime.history({globalVariables:{hp:7},settings:{preload_worldinfo_enabled:false,raw_message_evaluation_enabled:false},transcript:[{role:'assistant',content:source}]},[
    {global:{hp:9},append:{role:'assistant',content:source}},
    {global:{hp:11},settings:{render_loader_enabled:false}},
    {edit:{index:1,text:'修改后的值 <%= getGlobalVar("hp") %>'}},
    {restore:{from:0}}
  ])
  assert.match(states[0].chat[0].template_display.html,/当时的值 [\s\S]*7/)
  assert.deepEqual(states[1].chat[0].template_display,states[0].chat[0].template_display)
  assert.match(states[1].chat[1].template_display.html,/当时的值 [\s\S]*9/)
  assert.deepEqual(states[2].chat,states[1].chat)
  assert.deepEqual(states[3].chat[0],states[2].chat[0])
  assert.match(states[3].chat[1].template_display.html,/修改后的值 [\s\S]*11/)
  assert.deepEqual(states[4].chat,states[0].chat)
  const rendered=await runtime.page.evaluate(()=>window.historyRenderCounts)
  assert.equal(rendered[2],rendered[1])
  assert.equal(rendered[4],rendered[3])
  assert.ok(rendered[1]>rendered[0] && rendered[3]>rendered[2])
  // A fresh authoritative snapshot with a saved display must not evaluate it again.
  const reopened=await runtime.lifecycle({globalVariables:{hp:99},settings:{preload_worldinfo_enabled:false,raw_message_evaluation_enabled:false},transcript:states[0].chat.map(row=>({...row,role:'assistant',content:row.mes}))})
  assert.deepEqual(reopened.first.chat[0].template_display,states[0].chat[0].template_display)
})

test('长历史分批同步，每批最多八层，续批不重复执行变量修改', async () => {
  const states = await runtime.history({settings:{preload_worldinfo_enabled:false}, transcript:
    Array.from({length:20},()=>({role:'assistant',content:'<% setMessageVar("count", (getMessageVar("count") || 0) + 1) %>值 <%= getMessageVar("count") %>'}))
  }, [{}, {}, {}])
  const rows = Array.isArray(states) ? states : states.states
  assert.ok(rows)
  assert.deepEqual(rows.map(state => state.chat.filter(row => row.template_rendered).length), [8,16,20,20])
  assert.deepEqual(rows.at(-1).chat.map(row => row.variables[0].count), Array.from({length:20}, (_, i) => i + 1))
  assert.deepEqual(rows[3].chat, rows[2].chat)
  assert.deepEqual(rows[2].chat.slice(0,8), rows[0].chat.slice(0,8))
})
