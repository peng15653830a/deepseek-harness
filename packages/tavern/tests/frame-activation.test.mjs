import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../tavern-plugin/src/client/modules/frame-activation.js', import.meta.url), 'utf8')
function fixture(fallback = false) {
  const frames = new Map(), ran = []
  let id = 0
  const request = run => { frames.set(++id, run); return id }
  const cancel = id => frames.delete(id)
  const host = fallback ? { setTimeout: request, clearTimeout: cancel } : { requestAnimationFrame: request, cancelAnimationFrame: cancel }
  const enqueue = vm.runInNewContext(source + '; createTavernFrameActivationQueue', {})(host)
  const tick = () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(run => run()) }
  return { enqueue, tick, frames, ran }
}
for (const fallback of [false, true]) test(`同时进入视区的消息分帧首次激活，取消待启动项不影响已运行项 (${fallback})`, () => {
  const f = fixture(fallback)
  const cancelFirst = f.enqueue(() => f.ran.push('first'))
  const cancelSecond = f.enqueue(() => f.ran.push('second'))
  f.enqueue(() => f.ran.push('third'))
  assert.equal(f.frames.size, 1)
  f.tick()
  assert.deepEqual(f.ran, ['first'])
  cancelFirst(); cancelSecond()
  f.tick()
  assert.deepEqual(f.ran, ['first', 'third'])
  assert.equal(f.frames.size, 0)
  const cancelLast = f.enqueue(() => f.ran.push('unmounted'))
  cancelLast(); f.tick()
  assert.deepEqual(f.ran, ['first', 'third'])
})
test('首次激活失败不饿死后面的消息，重入任务等下一帧', () => {
  const f = fixture()
  f.enqueue(() => { f.enqueue(() => f.ran.push('later')); throw Error('failed') })
  assert.throws(f.tick, /failed/)
  assert.deepEqual(f.ran, [])
  f.tick()
  assert.deepEqual(f.ran, ['later'])
})

test('实际消息组件离开视区或卸载时取消启动，开场 eager 不入队', () => {
  const bundle = readFileSync(new URL('../tavern-plugin/lib/client.js', import.meta.url), 'utf8')
  const frames = new Map(), timers = new Map(), observers = [], activated = []
  let id = 0, descriptor, rendering
  const host = {
    __ModuleLoader__: { load(value) { descriptor = value } },
    requestAnimationFrame(run) { frames.set(++id, run); return id }, cancelAnimationFrame(id) { frames.delete(id) },
    setTimeout(run) { timers.set(++id, run); return id }, clearTimeout(id) { timers.delete(id) },
    IntersectionObserver: class {
      constructor(run) { this.run = run; observers.push(this) }
      observe() {} disconnect() { this.disconnected = true }
    },
  }
  const React = {
    useRef: value => ({ current: value }),
    useSyncExternalStore: () => [],
    useEffect: run => rendering.effects.push(run), useLayoutEffect() {},
    useState(value) {
      const state = rendering, index = state.states++
      return [typeof value === 'function' ? value() : value, value => { if (index === 1) activated.push([state.name, value]) }]
    },
    createElement(type, props, ...children) { if (props?.ref && typeof props.ref === 'object') props.ref.current = {}; return { type, props, children } },
  }
  vm.runInNewContext(bundle, { window: host, console })
  const client = descriptor.factory(name => name === 'react' ? React : {})
  function mount(name, eager = false) {
    rendering = { name, effects: [], states: 0 }
    client.TavernMessageFrame({ content: '<p>正文</p>', turn: 1, partIndex: 0, eager })
    return rendering.effects[2]()
  }
  const tick = tasks => { const runs = [...tasks.values()]; tasks.clear(); runs.forEach(run => run()) }
  const leave = mount('leave'), unmount = mount('unmount'), stay = mount('stay')
  tick(timers)
  for (const observer of observers) observer.run([{ isIntersecting: true }])
  assert.equal(frames.size, 1)
  observers[0].run([{ isIntersecting: false }])
  unmount()
  tick(frames)
  assert.deepEqual(activated, [['stay', true]])
  observers[0].run([{ isIntersecting: true }])
  tick(frames)
  assert.deepEqual(activated, [['stay', true], ['leave', true]])
  assert.equal(observers[0].disconnected, true)
  mount('opening', true)
  assert.deepEqual(activated.at(-1), ['opening', true])
  assert.equal(frames.size, 0)
  leave(); stay()
})
