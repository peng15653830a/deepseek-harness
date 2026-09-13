import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { helperClient } from './fixtures/helper-host-harness.mjs'

test('字号重测不读取 CSS transition 保留的上一次放大值', () => {
  const html = helperClient.buildTavernFrameDocument({ content: '', token: 'font' })
  const script = [...html.matchAll(/<script data-dsh-tavern-font-runtime>([\s\S]*?)<\/script>/g)].at(-1)[1]
  let mutation, receive, transitionDisabled = false, visibleSize = 20
  const attrs = new Map(), props = new Map()
  const node = {
    tagName: 'SPAN', childNodes: [{ nodeType: 3, nodeValue: '文字' }], closest() { return null },
    hasAttribute: key => attrs.has(key), getAttribute: key => attrs.get(key) || null,
    setAttribute: (key, value) => attrs.set(key, value), removeAttribute: key => attrs.delete(key),
    querySelectorAll: () => [],
    style: {
      getPropertyValue: key => props.get(key) || '', getPropertyPriority: () => '',
      setProperty: (key, value) => props.set(key, value), removeProperty: key => props.delete(key)
    }
  }
  const body = { ...node, tagName: 'BODY', childNodes: [], style: null,
    querySelectorAll: selector => selector.startsWith('[') ? (attrs.size ? [node] : []) : [node],
    hasAttribute: () => false }
  const parent = {}
  const context = {
    document: { body, documentElement: {}, head: { appendChild() { transitionDisabled = true } },
      createElement: () => ({ setAttribute() {}, remove() { transitionDisabled = false } }),
      addEventListener() {}, removeEventListener() {} },
    parent, window: {}, MutationObserver: class { constructor(fn) { mutation = fn } observe() {} disconnect() {} },
    requestAnimationFrame: fn => fn(),
    addEventListener(name, fn) { if (name === 'message') receive = fn }, removeEventListener() {},
    getComputedStyle() { return { fontSize: String(transitionDisabled ? parseFloat(props.get('font-size') || '20') : visibleSize), lineHeight: 'normal' } }
  }
  vm.runInNewContext(script, context)
  receive({ source: parent, data: { type: 'dsh-tavern-font-size', token: 'font', fontSize: 21 } })
  for (let i = 0; i < 4; i++) {
    visibleSize = parseFloat(props.get('font-size')) // Previous transition has completed.
    mutation()
    assert.equal(parseFloat(props.get('font-size')), 30)
  }
})
