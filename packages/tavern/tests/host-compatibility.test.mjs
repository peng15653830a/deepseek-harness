import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { classifyHostVersion, readHostCompatibility } from '../tavern-plugin/lib/domain/host-compatibility.js'

test('只适配唯一精确版本，其他版本和读取失败均不适配', () => {
  assert.equal(classifyHostVersion('0.1.2-rc.1', '0.1.2-rc.1').status, 'verified')
  assert.equal(classifyHostVersion('0.1.5-rc.1', '0.1.2-rc.1').status, 'incompatible')
  assert.equal(classifyHostVersion('0.2.0', '0.1.2-rc.1').status, 'incompatible')
  assert.equal(classifyHostVersion('', '0.1.2-rc.1').status, 'incompatible')
})
test('读取宿主依赖入口所属包，不误读同目录其他包；失败不阻塞', () => {
  const paths = []
  const info = readHostCompatibility({ resolveHost: () => '/host/session/lib/index.js', read(path) {
    paths.push(String(path))
    if (path instanceof URL) return '{"adaptedDshVersion":"0.1.2-rc.1"}'
    if (path === '/host/session/lib/package.json') return '{"name":"other","version":"9.0.0"}'
    if (path === '/host/session/package.json') return '{"name":"@deepseek-ai/dsh-session","version":"0.1.5-rc.1"}'
    throw Error('absent')
  } })
  assert.equal(info.version, '0.1.5-rc.1'); assert.equal(paths.length, 3)
  assert.equal(readHostCompatibility({ resolveHost: () => { throw Error('unavailable') } }).status, 'incompatible')
})
const source = readFileSync(new URL('../tavern-plugin/src/client/modules/host-compatibility.js', import.meta.url), 'utf8')
const create = vm.runInNewContext(source.slice(0, source.indexOf('const hostCompatibilityNotice')) + ';createHostCompatibilityNotice')
test('多次挂载并发读取只请求一次；关闭按版本保存', async () => {
  let requests = 0; const saved = new Map()
  const notice = create(async () => { requests++; return { compatibility: { version: '1' } } }, { getItem: k => saved.get(k), setItem: (k,v) => saved.set(k,v) })
  await Promise.all(Array.from({ length: 100 }, () => notice.load()))
  assert.equal(requests, 1)
  notice.dismiss({ version: '1' })
  assert.equal(notice.dismissed({ version: '1' }), true)
  assert.equal(notice.dismissed({ version: '2' }), false)
  assert.equal(notice.dismissed({ version: '' }), false)
})
test('旧宿主或断线请求失败也不自动重试，无轮询定时器', async () => {
  let requests = 0
  const notice = create(async () => { requests++; throw Error('unknown method') }, {})
  assert.equal(await notice.load(), null); assert.equal(await notice.load(), null)
  assert.equal(requests, 1)
  assert.doesNotMatch(source, /setInterval|setTimeout/)
})

test('提示展示核心版本，关闭仅隐藏说明，不隐藏版本号', async () => {
  const states = []; let cursor = 0; const effects = []
  const React = {
    useState(init) { const i = cursor++; if (!(i in states)) states[i] = init; return [states[i], v => { states[i] = v }] },
    useEffect(fn) { effects.push(fn) },
    createElement(type, props, ...children) { return { type, props, children } }
  }
  const notice = create(async () => ({ compatibility: classifyHostVersion('0.1.5-rc.1', '0.1.2-rc.1') }), { getItem() {}, setItem() {} })
  const render = vm.runInNewContext(source.slice(source.indexOf('function TavernHostCompatibility')) + ';TavernHostCompatibility', { React, hostCompatibilityNotice: notice })
  render(); effects.splice(0).forEach(fn => fn()); await notice.load(); await Promise.resolve()
  cursor = 0; const tree = render()
  assert.match(JSON.stringify(tree), /DSH 核心 0.1.5-rc.1/)
  const button = tree.children[1].children[1]
  button.props.onClick(); cursor = 0
  const closed = render()
  assert.equal(closed.children[1], null)
  assert.match(JSON.stringify(closed), /DSH 核心 0.1.5-rc.1/)
})
