import test from 'node:test'
import assert from 'node:assert/strict'
import { createJsonProjectionCache, createJsonValueProjectionCache } from '../tavern-plugin/lib/domain/immutable-json-projection.js'

test('内容相同复用，容量按 LRU 淘汰，失败不返回旧投影', () => {
  const cache = createJsonProjectionCache({ capacity: 2 })
  let projections = 0
  const read = (key, text) => cache(key, text, source => { projections++; return JSON.parse(source) })
  const a = read('a', '{"n":1}')
  read('b', '{}')
  assert.equal(read('a', '{"n":1}'), a)
  read('c', '{}')
  assert.equal(read('a', '{"n":1}'), a)
  read('b', '{}')
  assert.equal(projections, 4)
  assert.throws(() => read('a', 'broken'), SyntaxError)
  assert.notEqual(read('a', '{"n":1}'), a)
  assert.equal(read('a', '{"n":2}').n, 2)
})

test('超过缓存字节预算仍可读取，但不保留超大内容', () => {
  const cache = createJsonProjectionCache({ maxBytes: 20 })
  const small = cache('small', '{}', JSON.parse)
  const text = JSON.stringify({ content: 'x'.repeat(1000) })
  const first = cache('large', text, JSON.parse)
  assert.notEqual(cache('large', text, JSON.parse), first)
  assert.equal(cache('small', '{}', JSON.parse), small)
})

test('对象投影持有独立副本，命中不重新序列化，嵌套修改和删除立即生效', () => {
  const cache = createJsonValueProjectionCache()
  const input = { name: 'card', data: { text: 'x'.repeat(770000), enabled: true } }
  let calls = 0
  const project = source => { calls++; return { character: source } }
  const first = cache('card', input, project)
  assert.notEqual(first.character, input)
  assert.ok(Object.isFrozen(first.character.data))
  assert.equal(Object.isFrozen(input.data), false)
  const fresh = structuredClone(input)
  const stringify = JSON.stringify
  JSON.stringify = () => { throw new Error('unchanged resources must not serialize') }
  try { assert.equal(cache('card', fresh, project), first) }
  finally { JSON.stringify = stringify }
  input.data.enabled = false
  const changed = cache('card', input, project)
  assert.equal(first.character.data.enabled, true)
  assert.equal(changed.character.data.enabled, false)
  delete input.data.enabled
  assert.equal(Object.hasOwn(cache('card', input, project).character.data, 'enabled'), false)
  assert.equal(calls, 3)
})

test('对象缓存保持原 JSON 规范化及嵌套属性顺序，不以无序相等复用', () => {
  const cache = createJsonValueProjectionCache()
  for (const input of [
    { nested: { a: 1, b: 2 }, rows: [1, null] },
    { nested: { b: 2, a: 1 }, rows: [1, null] },
    { nested: { b: 2, a: 1 }, rows: [null, 1] },
    { missing: undefined, value: NaN, rows: [undefined] }
  ]) {
    assert.equal(JSON.stringify(cache('key', input, source => source)), JSON.stringify(input))
  }
})

test('对象缓存按容量和源数据加投影的体积淘汰，失败不复用旧投影', () => {
  const cache = createJsonValueProjectionCache({ capacity: 2, maxBytes: 100 })
  const project = source => source
  const a = cache('a', { n: 1 }, project)
  cache('b', {}, project)
  assert.equal(cache('a', { n: 1 }, project), a)
  cache('c', {}, project)
  assert.equal(cache('a', { n: 1 }, project), a)
  const big = { text: 'x'.repeat(1000) }
  assert.notEqual(cache('big', big, project), cache('big', big, project))
  // Even a tiny projection must budget its large source.
  assert.notEqual(cache('big', big, () => ({})), cache('big', big, () => ({})))
  assert.equal(cache('a', { n: 1 }, project), a)
  assert.throws(() => cache('a', { n: 2 }, () => { throw Error('invalid') }), /invalid/)
  assert.notEqual(cache('a', { n: 1 }, project), a)
})
