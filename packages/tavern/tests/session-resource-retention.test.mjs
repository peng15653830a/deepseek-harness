import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
const create = vm.runInNewContext(readFileSync(new URL('../tavern-plugin/src/client/modules/session-resource-retention.js', import.meta.url), 'utf8') + ';createTavernSessionRetention')
function fixture() {
  let now = 0, sequence = 0
  const timers = new Map(), released = []
  const cache = create({ now: () => now, window: {
    setTimeout(fn, ms) { timers.set(++sequence, { fn, at: now + ms }); return sequence }, clearTimeout(id) { timers.delete(id) },
  } })
  return { cache, timers, released, hold(id, type) { return cache.hold(id, type, () => released.push(id + ':' + type)) },
    advance(ms) { now += ms; for (const [id,timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn() } } }
}
test('会话切走保留10分钟，返回取消旧计时，下次离开重新计时', () => {
  const h = fixture(); h.cache.select('A'); h.hold('A','iframe'); h.hold('A','scripts')
  h.cache.select('B'); h.advance(599999); assert.equal(h.released.length,0)
  h.cache.select('A'); h.advance(600000); assert.equal(h.released.length,0)
  h.cache.select('B'); h.advance(599999); assert.equal(h.released.length,0)
  h.advance(1); assert.deepEqual(h.released,['A:iframe','A:scripts']); assert.equal(h.timers.size,0)
})
test('生成或结算跨过10分钟时不释放，完成后才释放；活动会话始终保留', () => {
  const h = fixture(); h.cache.select('A'); h.hold('A','scripts'); h.cache.busy('A',true)
  h.cache.select('B'); h.advance(600000); assert.equal(h.released.length,0)
  h.cache.busy('A',false); h.advance(0); assert.deepEqual(h.released,['A:scripts'])
  h.hold('B','iframe'); h.advance(600000); assert.equal(h.released.length,1)
})
test('React卸载不释放页面，离开后新建其他资源不能延后原截止时间', () => {
  const h = fixture(), unmount = h.cache.mount('A'); h.hold('A','iframe'); unmount()
  h.advance(500000); h.hold('A','status'); h.advance(100000)
  assert.deepEqual(h.released,['A:iframe','A:status'])
})
test('显式清理释放全部资源和定时器，旧清理回调不影响同名新会话', () => {
  const h = fixture(), forget = h.hold('A','iframe')
  h.cache.clear(); h.hold('A','iframe'); forget()
  h.advance(600000); assert.deepEqual(h.released,['A:iframe','A:iframe']); assert.equal(h.timers.size,0)
})

test('到期回调重新检查刚开始的脚本任务，不用上次空闲快照回收它', () => {
  const h = fixture(); let busy = false
  h.cache.select('A'); h.hold('A','scripts'); h.cache.busy('A', () => busy)
  h.cache.select('B'); busy = true; h.advance(600000)
  assert.equal(h.released.length,0)
  busy = false; h.cache.busy('A', () => busy); h.advance(0)
  assert.deepEqual(h.released,['A:scripts'])
})

const source = readFileSync(new URL('../tavern-plugin/src/client/main.js', import.meta.url), 'utf8')
const scopeSource = source.slice(source.indexOf('function createTavernHostArtifactScope(options)'), source.indexOf('const TAVERN_CARD_PHONE_HOST'))
test('旧会话到期仅清理自己的宿主节点，不能删除新会话或保留页面的容器', () => {
  function root() { return { children: [], append(node) { this.children.push(node); node.parentNode = this }, removeChild(node) { this.children.splice(this.children.indexOf(node),1) } } }
  const document = { head: root(), body: root() }
  const scope = vm.runInNewContext(scopeSource + ';createTavernHostArtifactScope')
  const a = scope({ document }), aNode = { hidden: false }
  document.body.append(aNode)
  const parking = { hasAttribute: name => name === 'data-tavern-retained-frames' }
  document.body.append(parking)
  a.setVisible(false)
  assert.equal(aNode.hidden, true)
  const b = scope({ document }), bNode = {}
  document.body.append(bNode)
  a.setVisible(true); assert.equal(aNode.hidden, false)
  a.setVisible(false); a.dispose()
  assert.deepEqual(document.body.children, [parking,bNode])
  b.dispose(); assert.deepEqual(document.body.children, [parking])
})
