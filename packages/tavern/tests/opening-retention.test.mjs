import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../tavern-plugin/src/client/main.js', import.meta.url), 'utf8')
function fixture() {
  const draft = { card: { path: 'fixture.json' }, preparationId: 'draft', index: 2, userName: '玩家', requestMode: 'dsh' }
  const state = { openingPicker: draft, picking: true, uiMode: 'play', requestMode: 'dsh' }
  const ctx = vm.createContext({ ...state, busy: false, compatibilityAvailable: true,
    playPrewarmRef: { current: { cancel() {} } }, cardBatch: { reset() {} },
    tavernErrorHub: { clear() {}, report() {}, resolve() {} }, setCards() {}, setMenuSession() {}, setCardEntry() {}, setError() {}, setChatImport() {}, setBusy() {},
    setOpeningPicker(value) { ctx.openingPicker = state.openingPicker = value },
    setPicking(value) { ctx.picking = state.picking = value },
    setUiMode(value) { ctx.uiMode = state.uiMode = value },
    setRequestMode(value) { ctx.requestMode = state.requestMode = value },
    call: async () => ({}), history: [], groupOfMode: v => v, isPlayMode: v => v !== 'card',
    props: { sessions: { clear() {} } }, window: { localStorage: { setItem() {} } },
    openSessionWhenReady: async () => {}, askConfirm: async () => false,
  })
  vm.runInContext(source.slice(source.indexOf('function openPicker()'), source.indexOf('async function loadInitialResources')), ctx)
  vm.runInContext(source.slice(source.indexOf('async function switchMode(nextMode)'), source.indexOf('async function renameConversation')), ctx)
  return { ctx, state, draft }
}
test('收起后重新打开仍使用原开局草稿', () => {
  const { ctx, state, draft } = fixture()
  ctx.closePicker(); ctx.openPicker()
  assert.equal(state.openingPicker, draft)
  assert.equal(state.picking, true)
})
test('切到工作台再回到游玩不清空开局，自动恢复原准备页', async () => {
  const { ctx, state, draft } = fixture()
  await ctx.switchMode('card'); await ctx.switchPlayRequestMode('dsh')
  assert.equal(state.openingPicker, draft)
  assert.equal(state.picking, true)
})
test('已有游玩历史也能恢复收起的准备页', async () => {
  const { ctx, state, draft } = fixture()
  ctx.history = [{ mode: 'story', sessionId: 'existing' }]
  ctx.closePicker()
  await ctx.switchPlayRequestMode('dsh')
  assert.equal(state.openingPicker, draft)
  assert.equal(state.picking, true)
})

test('放弃开局需确认，取消保留草稿；确认后释放草稿', async () => {
  const { ctx, state, draft } = fixture()
  await ctx.discardOpening()
  assert.equal(state.openingPicker, draft)
  const calls = []
  ctx.askConfirm = async () => true
  ctx.call = async (method, args) => calls.push([method, args.id])
  await ctx.discardOpening()
  assert.equal(state.openingPicker, null)
  assert.deepEqual(calls, [['releaseOpeningPreparation', 'draft']])
})

test('开局过程中遮罩点击不会收起或清除准备页', () => {
  const { ctx, state, draft } = fixture()
  ctx.busy = true
  ctx.closePicker()
  assert.equal(state.picking, true)
  assert.equal(state.openingPicker, draft)
})

const preview = readFileSync(new URL('../tavern-plugin/src/client/opening-preview.js', import.meta.url), 'utf8')
test('隐藏期间续期不重建界面，卸载后停止；失败不会重复刷屏', async () => {
  const retain = vm.runInNewContext(preview + '; retainOpeningPreparation')
  let tick, focus, pending, calls = 0, errors = 0, cleared = false
  const host = { setInterval(fn, ms) { tick = fn; assert.equal(ms, 60000); return 1 }, clearInterval() { cleared = true },
    addEventListener(name, fn) { assert.equal(name, 'focus'); focus = fn }, removeEventListener(name, fn) { assert.equal(fn, focus); focus = null } }
  const stop = retain('draft', { window: host, onError() { errors++ }, call(method, args) {
    assert.equal(method, 'getOpeningPreparation'); assert.equal(args.touchOnly, true); assert.equal(args.id, 'draft'); calls++
    return new Promise((resolve, reject) => { pending = { resolve, reject } })
  } })
  await tick(); assert.equal(calls, 1)
  pending.resolve(); await new Promise(resolve => setImmediate(resolve))
  const attempt = tick(); pending.reject(new Error('offline')); await attempt
  const again = focus(); pending.reject(new Error('offline')); await again
  assert.equal(errors, 1)
  stop(); await tick()
  assert.equal(calls, 3); assert.equal(cleared, true); assert.equal(focus, null)
})

for (const targetMode of ['card', 'story']) test(`完成 ${targetMode} 创建时只释放已经开局的准备页`, async () => {
  const { ctx, state, draft } = fixture()
  const calls = []
  Object.assign(ctx, { setPendingOpen() {}, publishSessionMode() {}, CustomEvent: class {},
    call: async (method, args) => calls.push([method, args.id]) })
  ctx.window.dispatchEvent = () => {}
  vm.runInContext(source.slice(source.indexOf('async function finishPendingOpen(pending)'), source.indexOf('const conversationLifecycle =', source.indexOf('async function finishPendingOpen(pending)'))), ctx)
  await ctx.finishPendingOpen({ sessionId: 'created', targetMode })
  assert.equal(state.openingPicker, targetMode === 'card' ? draft : null)
  assert.deepEqual(calls, targetMode === 'card' ? [] : [['releaseOpeningPreparation', 'draft']])
})

test('新版页面连接旧后端时使用已有读取接口续期，不报未知方法或重建开局', async () => {
  const retain = vm.runInNewContext(preview + '; retainOpeningPreparation')
  const calls = [], errors = []
  let tick, touches = 0
  const stop = retain('existing-draft', {
    window: { setInterval(fn) { tick = fn; return 1 }, clearInterval() {}, addEventListener() {}, removeEventListener() {} },
    async call(method, args) {
      calls.push(method)
      if (method !== 'getOpeningPreparation') throw Error('未知方法: ' + method)
      assert.equal(args.id, 'existing-draft')
      assert.equal(args.touchOnly, true)
      touches++
      // Old hosts ignore touchOnly and return their normal draft projection.
      return { id: args.id, worldbook: { entries: [{ content: '已选内容' }] } }
    },
    onError(error) { errors.push(error.message) },
  })
  await new Promise(resolve => setImmediate(resolve))
  await tick(); stop()
  assert.deepEqual(errors, [])
  assert.equal(touches, 2)
  assert.deepEqual(calls, ['getOpeningPreparation', 'getOpeningPreparation'])
})
