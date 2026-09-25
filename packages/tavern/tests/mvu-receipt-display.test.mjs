import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const source = await readFile(new URL('../tavern-plugin/lib/client.js', import.meta.url), 'utf8')
const start = source.indexOf('function TavernMvuReceipt(props)')
const end = source.indexOf('function htmlPartHasPresentation(', start)
assert.ok(start >= 0 && end > start)
const sandbox = vm.createContext({ React: {
  createElement(type, props, ...children) { return { type, props, children } },
  useState(value) { return [value, () => {}] }
} })
vm.runInContext(source.slice(start, end), sandbox)

function textOf(node) {
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  return typeof node === 'object' ? textOf(node.children) : String(node)
}

const change = path => ({ operation: 'set', path, before: '旧值', after: '新值' })
test('中断结算明确展示重试入口而不是仍在结算', () => {
  const text = textOf(sandbox.TavernMvuReceipt({ latest: true, receipt: { status: 'interrupted' } }))
  assert.match(text, /变量结算已中断/)
  assert.match(text, /重试变量结算/)
  assert.doesNotMatch(text, /变量结算中/)
})
const internal = [
  change('/delta_data/航班'), change('/display_data/航班/安全带'),
  change('/schema/properties/人物/properties/祈婉琳'),
  change('/delta_data'), change('/display_data'), change('/schema')
]

test('更新记录只展示真实变量及脚本联动，过滤内部记录并保留原始 receipt', () => {
  const receipt = { status: 'updated', changes: [change('/stat_data/航班/安全带')],
    sideEffects: [...internal, change('/stat_data/航班/阶段')], failures: [] }
  const before = structuredClone(receipt)
  const text = textOf(sandbox.TavernMvuReceipt({ receipt }))
  assert.doesNotMatch(text, /\/delta_data|\/display_data|\/schema/)
  assert.match(text, /变量已更新 · 1 项 · 人物卡联动 1 项/)
  assert.match(text, /\/stat_data\/航班\/安全带/)
  assert.match(text, /人物卡脚本联动/)
  assert.match(text, /\/stat_data\/航班\/阶段/)
  assert.deepEqual(receipt, before)
})

test('只有内部变化时不展示联动标题或计数', () => {
  const node = sandbox.TavernMvuReceipt({ receipt: { status: 'unchanged', sideEffects: internal } })
  const text = textOf(node)
  assert.equal(node.type, 'div')
  assert.match(text, /本轮变量未更新/)
  assert.doesNotMatch(text, /联动|delta_data|display_data|schema/)
})

test('只过滤顶层保留字段，不误删同名业务变量或失败详情', () => {
  const receipt = { status: 'partial', changes: [change('/stat_data/位置')], sideEffects: [
    ...internal, change('/stat_data/display_data'), change('/display_data_extra')
  ], failures: [{ operation: 'replace', path: '/stat_data/年龄', message: '结构校验失败' }] }
  const text = textOf(sandbox.TavernMvuReceipt({ receipt }))
  assert.match(text, /1 项成功 · 1 项失败 · 人物卡联动 2 项/)
  assert.match(text, /\/stat_data\/display_data/)
  assert.match(text, /\/display_data_extra/)
  assert.match(text, /结构校验失败/)
  const errorText = textOf(sandbox.TavernMvuReceipt({ latest: true, receipt: { ...receipt, status: 'error' } }))
  assert.match(errorText, /重试变量结算/)
})


test('只有最新正文提供重算入口，忙碌时禁用，指导意见随请求提交', async () => {
  const receipt = { status: 'updated', changes: [] }
  const historical = sandbox.TavernMvuReceipt({ receipt, latest: false })
  assert.doesNotMatch(textOf(historical), /重新结算变量/)
  const findButton = node => {
    if (!node || typeof node !== 'object') return null
    if (node.type === 'button') return node
    for (const child of (Array.isArray(node) ? node : node.children || [])) {
      const found = findButton(child)
      if (found) return found
    }
    return null
  }
  const current = sandbox.TavernMvuReceipt({ receipt, latest: true, sessionId: 's', turn: 2 })
  assert.equal(current.type, 'details')
  assert.match(textOf(current), /重新结算变量/)
  const busy = sandbox.TavernMvuReceipt({ receipt, latest: true, busy: true })
  assert.equal(findButton(busy).props.disabled, true)
  let request
  sandbox.askTavernText = async options => {
    assert.equal(options.allowEmpty, true)
    await options.onSubmit('不要扣库存')
  }
  sandbox.rpc = async (...args) => { request = args }
  sandbox.liveTavernView = { invalidate() {} }
  sandbox.tavernErrorHub = { report(_label, error) { throw error } }
  await findButton(current).props.onClick()
  assert.equal(request[0], 'retrySettlement')
  assert.equal(request[1].turn, 2)
  assert.equal(request[1].guidance, '不要扣库存')
  assert.equal(request[2], 's')
})
