import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
const source = await readFile(new URL('../tavern-plugin/src/client/main.js', import.meta.url), 'utf8')
const code = source.slice(source.indexOf('function installTavernImmersiveMode('), source.indexOf('function TavernImmersiveAction('))
const install = new Function(code + ';return installTavernImmersiveMode')()
test('沉浸模式保留外部恢复入口，恢复焦点，卸载还原顶部栏', () => {
  const classes = new Set(), events = new Map()
  let focused = '', removed = false, sibling
  const restore = { setAttribute() {}, addEventListener: (k, v) => events.set(k, v), removeEventListener: k => events.delete(k), focus: () => { focused = 'restore' }, remove: () => { removed = true } }
  const header = { classList: { add: k => classes.add(k), remove: k => classes.delete(k) }, ownerDocument: { createElement: () => restore }, before: node => { sibling = node } }
  const controller = install({ closest: () => header, focus: () => { focused = 'entry' } })
  assert.equal(sibling, restore)
  assert.equal(restore.hidden, true)
  controller.enter()
  assert.ok(classes.has('dsh-tavern-immersive-header'))
  assert.equal(restore.hidden, false)
  assert.equal(focused, 'restore')
  events.get('click')()
  assert.equal(classes.size, 0)
  assert.equal(focused, 'entry')
  controller.enter()
  controller.dispose()
  assert.equal(classes.size, 0)
  assert.equal(events.size, 0)
  assert.equal(removed, true)
})
