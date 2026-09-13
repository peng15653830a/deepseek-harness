import assert from 'node:assert/strict'
import test from 'node:test'

import { projectPersistentStatusView } from '../tavern-plugin/lib/domain/persistent-status-view.js'

function projection(turn, parts) {
  return { version: 2, turn, mode: 'html', text: '', parts, warnings: [] }
}

test('MVU 读写不是面板用途声明，多开档前端全部保留在原消息', () => {
  const parts = [{ kind: 'html', content: '<script>createCharacter()</script>' },
    { kind: 'html', content: '<script>editInventory()</script>' }]
  const messages = [{ role: 'assistant', turn: 1, displayRuntime: { frames: [
    { partIndex: 0, mvuViewUsed: true }, { partIndex: 1, mvuViewUsed: true }] } }, { role: 'assistant', turn: 5 }]
  const projections = [projection(1, parts)]
  const result = projectPersistentStatusView(messages, projections)
  assert.equal(result.statusView, null)
  assert.deepEqual(result.statusViews, [])
  assert.deepEqual(result.projections, projections)
})

test('多个声明模板有稳定独立身份，重复模板只挂载一次，换轮不改变身份', () => {
  const rules = ['hp', 'inventory', 'hp'].map(name => ({ name, enabled: true, placement: [2], markdownOnly: true,
    findRegex: '/<StatusPlaceHolderImpl\\/>/g', replaceString: '<script>' + name + '()</script>' }))
  const result = projectPersistentStatusView([{ role: 'assistant', turn: 3 }], [], { regexScripts: rules })
  const next = projectPersistentStatusView([{ role: 'assistant', turn: 4 }], [], { regexScripts: rules })
  assert.equal(result.statusViews.length, 2)
  assert.notEqual(result.statusViews[0].viewId, result.statusViews[1].viewId)
  assert.deepEqual(result.statusViews.map(v => v.viewId), next.statusViews.map(v => v.viewId))
  assert.ok(next.statusViews.every(v => v.targetTurn === 4))
})

test('声明状态栏的卡保留开局页，正文推进后使用声明模板而非 MVU 开局页', () => {
  const opening = '<script>loadCustomStart()</script>'
  const status = '<script>loadRealStatus()</script>'
  const regexScripts = [{ enabled: true, placement: [2], markdownOnly: true,
    findRegex: '<StatusPlaceHolderImpl/>', replaceString: '```html\n' + status + '\n```', maxDepth: 2 }]
  const messages = [{ role: 'assistant', turn: 1, displayRuntime: { frames: [{ partIndex: 0, mvuViewUsed: true }] } }]
  const projections = [projection(1, [{ kind: 'html', content: opening }])]
  const initial = projectPersistentStatusView(messages, projections, { regexScripts })
  assert.equal(initial.statusView, null)
  assert.deepEqual(initial.projections, projections)
  const advanced = projectPersistentStatusView([...messages, { role: 'assistant', turn: 6, text: '抵达庄园' }], projections, { regexScripts })
  assert.match(advanced.statusView.content, /loadRealStatus/)
  assert.equal(advanced.statusView.targetTurn, 6)
  assert.deepEqual(advanced.projections, projections)
  assert.equal(projectPersistentStatusView([...messages, { role: 'assistant', turn: 6 }], [], { regexScripts }).statusView.targetTurn, 6)
})

test('声明模板在开场已出现时立即提升，禁用声明不加载远程页面', () => {
  const content = '<script>loadRealStatus()</script>'
  const rule = { enabled: true, placement: [2], markdownOnly: true,
    findRegex: '<StatusPlaceHolderImpl/>', replaceString: content }
  const messages = [{ role: 'assistant', turn: 1 }]
  const projections = [projection(1, [{ kind: 'html', content }])]
  const result = projectPersistentStatusView(messages, projections, { regexScripts: [rule] })
  assert.equal(result.statusView.content, content)
  assert.deepEqual(result.projections[0].parts, [])
  for (const disabled of [{ enabled: false }, { disabled: true }]) {
    assert.equal(projectPersistentStatusView([...messages, { role: 'assistant', turn: 2 }], [],
      { regexScripts: [{ ...rule, ...disabled }] }).statusView, null)
  }
})
