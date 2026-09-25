import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../tavern-plugin/src/client/main.js', import.meta.url), 'utf8')
const line = source.split('\n').find(line => line.includes('className: "dsh-tavern-player-name"'))
function input(state, update) {
  const tree = vm.runInNewContext(line.trim().replace(/,$/, ''), {
    h: (tag, props, ...children) => ({ tag, props, children }),
    openingPicker: state, busy: false, setOpeningPicker: update,
  })
  return tree.children.find(node => node?.tag === 'input').props
}

test('玩家称呼可清空再输入，不在编辑中强制填回默认称呼', () => {
  let state = { userName: '你', card: { path: 'test.json' } }
  const update = value => { state = typeof value === 'function' ? value(state) : value }
  input(state, update).onChange({ target: { value: '' } })
  assert.equal(input(state, update).value, '')
  input(state, update).onChange({ target: { value: '陈锋' } })
  assert.equal(input(state, update).value, '陈锋')
})

test('输入不覆盖同一期间返回的开场准备信息，也不恢复已关闭的面板', () => {
  let state = { userName: '你', preparationId: 'old' }
  const update = value => { state = typeof value === 'function' ? value(state) : value }
  const handler = input(state, update).onChange
  state = { ...state, preparationId: 'new' }
  handler({ target: { value: '玩家' } })
  assert.equal(state.preparationId, 'new')
  state = null
  handler({ target: { value: '玩家二' } })
  assert.equal(state, null)
})


test('全局不再提供默认玩家称呼', () => {
  assert.doesNotMatch(source, /saveDefaultPlayerName|aria-label.*默认玩家称呼/)
})
