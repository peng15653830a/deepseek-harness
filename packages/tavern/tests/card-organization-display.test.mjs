import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../tavern-plugin/src/client/card-organization.js', import.meta.url), 'utf8')
const context = vm.createContext({})
vm.runInContext(source, context)

test('全部保留所有卡及既有排序；收藏、分组和搜索组合过滤且不重复', () => {
  const cards = [
    { path: 'c', name: '收藏卡', group: '奇幻', starred: true },
    { path: 'b', name: '未分组卡', group: '' },
    { path: 'a', name: '奇幻卡', group: '奇幻' }
  ]
  const paths = (filter, query = '') => Array.from(context.filterOrganizedCards(cards, filter, query), card => card.path)
  assert.deepEqual(paths('*'), ['c', 'b', 'a'])
  assert.deepEqual(paths('favorites'), ['c'])
  assert.deepEqual(paths('group:'), ['b'])
  assert.deepEqual(paths('group:奇幻'), ['c', 'a'])
  assert.deepEqual(paths('*', '奇幻'), ['a'])
  assert.deepEqual(paths('favorites', '奇幻'), [])
})
