import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'
import { autoRetryableFailure, autoShotCount } from '../tavern-plugin/lib/domain/scene-illustration.js'
import { validateAutoSettings } from '../tavern-plugin/lib/domain/scene-image-module-settings.js'

const policy = { enabled: true, minPerTurn: 3, charsPerImage: 500, maxPerTurn: 9 }

test('one settled turn earns at least the minimum and roughly one image per configured characters', () => {
  assert.equal(autoShotCount(0, policy), 3, 'an empty turn still earns the minimum')
  assert.equal(autoShotCount(800, policy), 3, 'below the density the minimum holds')
  assert.equal(autoShotCount(2000, policy), 4)
  assert.equal(autoShotCount(4500, policy), 9)
  assert.equal(autoShotCount(60000, policy), 9, 'the per-turn ceiling caps a long turn')
  assert.equal(autoShotCount(1200, { ...policy, minPerTurn: 1, charsPerImage: 1200, maxPerTurn: 9 }), 1)
})

test('only a queue-full or rate-limited NovelAI answer may be retried automatically', () => {
  const failure = (provider, httpStatus) => ({ configuration: { provider }, diagnostics: { providerFailure: { httpStatus } } })
  assert.equal(autoRetryableFailure(failure('novelai', 503)), true)
  assert.equal(autoRetryableFailure(failure('novelai', 429)), true)
  assert.equal(autoRetryableFailure(failure('novelai', 500)), false, 'an unknown 5xx may already be billing')
  assert.equal(autoRetryableFailure(failure('novelai', 400)), false)
  assert.equal(autoRetryableFailure(failure('openai', 503)), false, 'other channels keep the strict no-retry rule')
  assert.equal(autoRetryableFailure(undefined), false)
  assert.equal(autoRetryableFailure({ configuration: { provider: 'novelai' } }), false)
})

test('auto policy validation keeps the batch runner inside its documented bounds', () => {
  assert.deepEqual(validateAutoSettings({}), { enabled: false, minPerTurn: 3, charsPerImage: 500, maxPerTurn: 9 })
  assert.deepEqual(validateAutoSettings({ enabled: true, minPerTurn: 2, charsPerImage: 800, maxPerTurn: 6 }),
    { enabled: true, minPerTurn: 2, charsPerImage: 800, maxPerTurn: 6 })
  assert.throws(() => validateAutoSettings({ enabled: 'yes' }), /布尔值/)
  assert.throws(() => validateAutoSettings({ minPerTurn: 0 }), /1–9/)
  assert.throws(() => validateAutoSettings({ maxPerTurn: 10 }), /1–9/)
  assert.throws(() => validateAutoSettings({ charsPerImage: 50 }), /100–5000/)
  assert.throws(() => validateAutoSettings({ charsPerImage: 500.5 }), /100–5000/)
  assert.throws(() => validateAutoSettings({ minPerTurn: 6, maxPerTurn: 3 }), /不能小于/)
  assert.throws(() => validateAutoSettings(null), /对象/)
})

const source = await readFile(new URL('../tavern-plugin/lib/client.js', import.meta.url), 'utf8')
const component = source.slice(source.indexOf('function SceneImageSettings()'), source.indexOf('function TavernSettingsSection()'))

/** Minimal client harness: only the auto block needs a form that already carries a policy. */
function fixture(initial = {}) {
  const slots = [], calls = []
  let cursor = 0
  let saved = { provider: 'novelai', activeProvider: 'novelai', enabled: true, ready: true, model: 'nai-diffusion-4-5-full', baseURL: 'https://example.test',
    style: { preset: 'default', custom: '' }, auto: { enabled: false, minPerTurn: 3, charsPerImage: 500, maxPerTurn: 9 },
    channels: [{ id: 'novelai', fields: ['baseURL', 'model', 'size', 'negativePrompt', 'steps', 'guidance'], models: [] }], ...initial }
  const context = vm.createContext({
    React: { createElement: (type, props, ...children) => ({ type, props, children }), useEffect() {}, useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value }] } },
    window: { dispatchEvent() {} }, CustomEvent: class {},
    URLSearchParams, rpc: async (method, args) => { calls.push({ method, args }); saved = { ...saved, ...args }; return { settings: structuredClone(saved) } }
  })
  const Component = vm.runInContext(component + ';SceneImageSettings', context)
  const nodes = tree => tree && typeof tree === 'object' ? [tree, ...(tree.children || []).flat(Infinity).flatMap(nodes)] : []
  const render = () => { cursor = 0; return nodes(Component()) }
  render(); slots[0] = structuredClone(saved)
  return { render, calls, slots,
    autoSwitch: () => render().filter(n => n.props?.role === 'switch')[1],
    number: label => render().find(n => n.type === 'label' && String(n.children?.[0] || '').startsWith(label)).children[1],
    saveAuto: () => render().find(n => n.type === 'button' && n.children.includes('保存自动设置')).props.onClick() }
}

test('auto policy saves through the image settings RPC without touching the channel fields', async () => {
  const f = fixture()
  assert.equal(f.autoSwitch().props.checked, false)
  f.render().find(n => String(n.children?.[0] || '') === '自动配图').children[1].props.onChange({ target: { checked: true } })
  f.number('每轮最少张数').props.onChange({ target: { value: '2' } })
  f.number('每多少字一张').props.onChange({ target: { value: '800' } })
  f.number('每轮最多张数').props.onChange({ target: { value: '6' } })
  await f.saveAuto()
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].method, 'saveSceneImageSettings')
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0].args)), { provider: 'novelai', auto: { enabled: true, minPerTurn: 2, charsPerImage: 800, maxPerTurn: 6 } })
  assert.ok(f.render().some(n => n.props?.role === 'status' && n.children.includes('自动配图已开启，下次结算后生效')))
})

test('auto policy follows the saved settings and renders only in the expanded form', () => {
  const collapsed = fixture({ enabled: false, auto: { enabled: true, minPerTurn: 3, charsPerImage: 500, maxPerTurn: 9 } })
  assert.equal(collapsed.render().some(n => n.type === 'details'), false)
  const open = fixture({ auto: { enabled: true, minPerTurn: 4, charsPerImage: 600, maxPerTurn: 8 } })
  assert.equal(open.autoSwitch().props.checked, true)
  assert.equal(open.number('每轮最少张数').props.value, 4)
  assert.equal(open.number('每多少字一张').props.value, 600)
  assert.equal(open.number('每轮最多张数').props.value, 8)
})
