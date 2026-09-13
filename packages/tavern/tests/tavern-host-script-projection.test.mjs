import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { projectTavernHostScript, projectTavernHostHtml } from '../tavern-plugin/lib/domain/tavern-host-script-projection.js'

test('卡片原样访问顶层宿主，编译后进入本地接口，真实顶层窗口仍不可访问', () => {
  const outer = new Proxy({}, { get() { throw Error('cross origin') } })
  const context = vm.createContext({ window: { top: outer }, TavernHelper: { getCharWorldbookNames: () => ({ primary: '本局世界书' }) }, SillyTavern: { getContext: () => ({ ready: true }) } })
  const source = `window.top?.TavernHelper.getCharWorldbookNames('current').primary + ':' + top['SillyTavern'].getContext().ready`
  assert.throws(() => vm.runInContext(source, context), /cross origin/)
  assert.equal(vm.runInContext(projectTavernHostScript(source), context), '本局世界书:true')
  assert.throws(() => vm.runInContext(projectTavernHostScript('window.top.document'), context), /cross origin/)
})
test('不修改字符串、注释、非宿主访问或脚本自己的局部 window', () => {
  for (const source of [`'window.top.SillyTavern'`, '// window.top.SillyTavern\n1', 'window.top.location', 'function f(window) { return window.top.SillyTavern }']) assert.equal(projectTavernHostScript(source), source)
  assert.equal(projectTavernHostHtml('<p>window.top.SillyTavern</p><script>window.top.SillyTavern.getContext()</script>'), '<p>window.top.SillyTavern</p><script>globalThis.SillyTavern.getContext()</script>')
})

import { projectCachedResourceBody } from '../tavern-plugin/lib/domain/tavern-static-resource-cache.js'
test('远程首页经过实际缓存响应路径后可以读取本地 EJS 宿主设置', () => {
  const html = `<script type="module">globalThis.result = window.top?.SillyTavern.getContext().extensionSettings.EjsTemplate.enabled;</script>`
  const asset = { url: 'https://example.com/home/index.html', mediaType: 'text/html', body: Buffer.from(html) }
  const projected = projectCachedResourceBody(asset).toString()
  const context = vm.createContext({ SillyTavern: { getContext: () => ({ extensionSettings: { EjsTemplate: { enabled: true } } }) } })
  vm.runInContext(projected.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1], context)
  assert.equal(context.result, true)
  assert.equal(asset.body.toString(), html, '缓存原件不变，编译只作用于响应投影')
})
