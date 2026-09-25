import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

import { readTavernClientAsset, TAVERN_CLIENT_ASSET_PREFIX } from '../tavern-plugin/lib/domain/tavern-client-assets.js'

test('Tavern 客户端样式作为独立本地资源提供', async () => {
  assert.equal(TAVERN_CLIENT_ASSET_PREFIX, '/api/dsh-tavern/client-assets/')
  const asset = await readTavernClientAsset('/api/dsh-tavern/client-assets/tavern.css')
  assert.equal(asset.mediaType, 'text/css; charset=utf-8')
  assert.match(asset.body.toString('utf8'), /\.dsh-tavern-sidebar/)
  assert.match(asset.body.toString('utf8'), /@keyframes dsh-tavern-pulse/)
})

test('Web 宿主直接注入完整内置样式，重复加载与升级复用同一个节点', async () => {
  const source = await readFile(new URL('../tavern-plugin/lib/client.js', import.meta.url), 'utf8')
  const css = await readFile(new URL('../tavern-plugin/lib/client-assets/tavern.css', import.meta.url), 'utf8')
  const nodes = []
  const document = {
    querySelector() { return nodes.find(node => node.tag === 'style') },
    querySelectorAll() { return [...nodes] },
    createElement(tag) {
      assert.equal(tag, 'style', 'no external stylesheet link')
      return { tag, dataset: {}, remove() { nodes.splice(nodes.indexOf(this), 1) } }
    },
    head: { appendChild(node) { nodes.push(node) } }
  }
  let descriptor
  vm.runInNewContext(source, { document, window: { __ModuleLoader__: { load(value) { descriptor = value } } }, console })
  descriptor.factory(() => ({}))
  assert.equal(nodes.length, 1)
  const current = nodes[0]
  assert.equal(current.textContent, css)
  assert.equal(current.dataset.plugin, 'dsh-tavern-plugin')
  descriptor.factory(() => ({}))
  assert.equal(nodes.length, 1)
  current.textContent = 'outdated styles'
  descriptor.factory(() => ({}))
  assert.equal(nodes[0], current)
  assert.equal(current.textContent, css)
  assert.doesNotMatch(source, /__TAVERN_BUNDLED_CSS__|client-assets\/tavern\.css\?v=/)
})
