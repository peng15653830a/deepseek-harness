import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../tavern-plugin/lib/client.js', import.meta.url), 'utf8')
const component = source.slice(source.indexOf('function SceneImageSettings()'), source.indexOf('function TavernSettingsSection()'))
function fixture(initial = {}) {
  const slots = [], calls = []
  let cursor = 0, failure = false
  let saved = { provider: 'openai', activeProvider: 'openai', enabled: false, ready: false, model: 'image', baseURL: 'https://example.test/v1', style: { preset: 'default', custom: '' }, channels: [{ id: 'openai', fields: ['baseURL', 'model'], models: ['image'] }], ...initial }
  const context = vm.createContext({
    React: { createElement: (type, props, ...children) => ({ type, props, children }), useEffect() {}, useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value }] } },
    window: { dispatchEvent() {} }, CustomEvent: class {},
    rpc: async (method, args) => {
      calls.push({ method, args }); assert.equal(method, 'saveSceneImageSettings')
      if (failure) throw new Error('保存失败')
      saved = { ...saved, ...args, ready: true }
      return { settings: structuredClone(saved) }
    }
  })
  const Component = vm.runInContext(component + ';SceneImageSettings', context)
  const nodes = tree => tree && typeof tree === 'object' ? [tree, ...(tree.children || []).flat(Infinity).flatMap(nodes)] : []
  const render = () => { cursor = 0; return nodes(Component()) }
  render(); slots[0] = structuredClone(saved)
  return { render, calls, slots, fail: () => { failure = true },
    save: () => render().find(n => n.type === 'button' && n.children.includes('保存生图 API 配置')).props.onClick() }
}

test('global API form is visible while disabled and saving never enables a game', async () => {
  const f = fixture({ enabled: false })
  assert.equal(f.render().filter(n => n.props?.role === 'switch').length, 0)
  assert.ok(f.render().some(n => n.type === 'select'))
  await f.save()
  assert.equal(f.calls.length, 1)
  assert.equal(Object.hasOwn(f.calls[0].args, 'enabled'), false)
  assert.equal(f.slots[0].enabled, false)
})

test('global API save failure preserves draft credentials and displays the error', async () => {
  const f = fixture(); f.slots[2] = 'draft-key'; f.fail()
  await f.save()
  assert.equal(f.slots[2], 'draft-key')
  assert.ok(f.render().some(n => n.props?.role === 'status' && n.children.includes('保存失败')))
})
