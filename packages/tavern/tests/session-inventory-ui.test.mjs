import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'
const source = await readFile(new URL('../tavern-plugin/src/client/session-inventory.js', import.meta.url), 'utf8')

test('统计页按需查询、分页筛选，并显示未知值与查询失败', async () => {
  const states = [], refs = [], effects = []
  let cursor = 0, refCursor = 0, calls = 0, fail = false
  const result = { capturedAt: 1, memory: { rss: 1024, heapUsed: 512 }, totals: { sessions: 61, loaded: 0, knownDiskBytes: 0, unknownDiskSize: 61 },
    rows: Array.from({ length: 61 }, (_, i) => ({ sessionId: 's-' + i, loaded: false, running: false, archived: null, eventCount: null, diskBytes: null, fileModifiedAt: null, references: [] })) }
  result.rows[60].references = [{ chatId: 'game', title: '原来的游戏', relation: 'ancestor', viaSessionId: 'front', lastOpenedAt: null }]
  const render = vm.runInNewContext(source + '; SessionInventoryDialog', { React: {
    useState(initial) { const i = cursor++; if (!(i in states)) states[i] = initial; return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value }] },
    useRef(initial) { return refs[refCursor++] ||= { current: initial } }, useEffect(fn) { effects.push(fn) },
    createElement: (type, props, ...children) => ({ type, props, children })
  }, rpc: async method => { assert.equal(method, 'getSessionInventory'); calls++; if (fail) throw new Error('读取失败'); return result } })
  function tree() {
    cursor = 0; refCursor = 0; effects.length = 0
    const nodes = []
    function visit(node) { if (Array.isArray(node)) return node.forEach(visit); if (!node || typeof node !== 'object') return; nodes.push(node); node.children?.forEach(visit) }
    visit(render({ sessionId: 's', onClose() {} })); return nodes
  }
  tree(); const dispose = effects[0](); await new Promise(resolve => setImmediate(resolve))
  let nodes = tree()
  assert.equal(nodes.filter(node => node.type === 'tr').length, 51)
  assert.match(JSON.stringify(nodes), /未知/)
  nodes.find(node => node.type === 'button' && node.children.includes('下一页')).props.onClick()
  assert.equal(tree().filter(node => node.type === 'tr').length, 12)
  tree().find(node => node.type === 'input').props.onChange({ target: { value: 's-60' } })
  assert.equal(tree().filter(node => node.type === 'tr').length, 2)
  tree().find(node => node.type === 'input').props.onChange({ target: { value: '原来的游戏' } })
  assert.equal(tree().filter(node => node.type === 'tr').length, 2)
  assert.match(JSON.stringify(tree()), /来源会话 front/)
  assert.equal(calls, 1)
  result.rows[60].backgroundState = 'historical'
  assert.equal(tree().filter(node => node.type === 'tr').length, 1)
  tree().find(node => node.type === 'button' && String(node.children[0]).startsWith('展开历史后台')).props.onClick()
  assert.equal(tree().filter(node => node.type === 'tr').length, 2)
  assert.match(JSON.stringify(tree()), /历史后台（仅存档）/)
  fail = true
  await tree().find(node => node.type === 'button' && node.children.includes('刷新')).props.onClick()
  assert.equal(tree().find(node => node.props?.role === 'alert').children[0], '读取失败')
  dispose()
})
