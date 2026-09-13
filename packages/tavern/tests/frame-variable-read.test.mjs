import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { projectPersistentStatusView } from '../tavern-plugin/lib/domain/persistent-status-view.js'

let descriptor
vm.runInNewContext(await readFile(new URL('../tavern-plugin/lib/client.js', import.meta.url), 'utf8'), {
  window: { __ModuleLoader__: { load(value) { descriptor = value } } }
})
const client = descriptor.factory(() => ({}))
const template = '<script>const hasMvu=typeof getAllVariables === "function"; if(hasMvu)getAllVariables().stat_data;</script>'

function frame(observeMvuView = true) {
  const state = { version: 1, stateRevision: 1, chatVariables: { theme: 'dark', stat_data: { hp: 1 } },
    messages: [{ message_id: 0, variables: { stat_data: { hp: 10 } } }, { message_id: 1, variables: { stat_data: { hp: 99 } } }],
    turnMessageIds: { '1': 0, '2': 1 } }
  const html = client.buildTavernFrameDocument({ content: template, token: 'probe', turn: 1, helperContext: state, observeMvuView })
  const reports = [], handlers = {}
  const parent = { postMessage(data) { reports.push(data) } }
  const context = { parent, console, structuredClone, addEventListener(type, handler) { handlers[type] = handler } }
  context.window = context
  vm.createContext(context)
  for (const match of html.matchAll(/<script data-dsh-tavern-(?:helper|frame-variable-aliases|mvu-view-observer)>([\s\S]*?)<\/script>/g)) {
    vm.runInContext(match[1].replace(/import\("[^"]+"\)/, 'Promise.resolve({})'), context)
  }
  return { state, context, reports, handlers, parent }
}

test('getAllVariables 读取当前楼层与聊天变量的独立快照，不泄漏后续楼层', () => {
  const run = frame()
  assert.equal(typeof run.context.getAllVariables, 'function')
  const value = run.context.getAllVariables()
  assert.equal(value.stat_data.hp, 10)
  assert.equal(value.theme, 'dark')
  value.stat_data.hp = 0
  assert.equal(run.context.getAllVariables().stat_data.hp, 10)
})

test('实际调用 getAllVariables 只记录一次诊断，不再自动迁移页面', () => {
  const run = frame()
  assert.equal(run.reports.length, 0)
  vm.runInContext(template.match(/<script>(.*)<\/script>/)[1], run.context)
  const reports = run.reports.filter(item => item.type === 'dsh-tavern-mvu-view-used')
  assert.equal(reports.length, 1)
  run.context.getAllVariables()
  assert.equal(run.reports.filter(item => item.type === 'dsh-tavern-mvu-view-used').length, 1)
  const prose = { kind: 'html', content: '<p>剧情保持原样</p>' }
  const result = projectPersistentStatusView([{ role: 'assistant', turn: 1,
    displayRuntime: { frames: [{ partIndex: 1, mvuViewUsed: reports[0].mvuViewUsed }] } }],
  [{ turn: 1, parts: [prose, { kind: 'html', content: template }] }])
  assert.equal(result.statusView, null)
  assert.deepEqual(result.projections[0].parts, [prose, { kind: 'html', content: template }])
})

test('右侧状态栏继续读取更新后的变量，不重复识别或重建 iframe', async () => {
  const run = frame(false)
  assert.equal(typeof run.context.getAllVariables, 'function')
  let displayed = run.context.getAllVariables().stat_data.hp
  run.context.eventOn(run.context.Mvu.events.VARIABLE_UPDATE_ENDED, () => {
    displayed = run.context.getAllVariables().stat_data.hp
  })
  const next = structuredClone(run.state)
  next.stateRevision = 2
  next.messages[0].variables.stat_data.hp = 8
  run.handlers.message({ source: run.parent, data: { type: 'dsh-tavern-helper-context-update', token: 'probe',
    update: client.createTavernHelperContextUpdate(null, next, 1, 1) } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(displayed, 8)
  assert(!run.reports.some(item => item.type === 'dsh-tavern-mvu-view-used'))
})

test('预设自检面板按 TH-message 名称识别实际楼层，持久页面换轮后同步更新', async () => {
  const run = frame(false)
  // Dream self-repair's detection order: window.name, frame id/name, then .mes[mesid].
  const detect = () => vm.runInContext(`(() => {
    const names = [window.name, window.frameElement && window.frameElement.id,
      window.frameElement && window.frameElement.getAttribute('name')].filter(Boolean);
    for (const name of names) {
      const matched = String(name).match(/^TH-message--(\\d+)--/);
      if (matched) return Number(matched[1]);
    }
    const message = window.frameElement && window.frameElement.closest('.mes[mesid]');
    const id = message && Number(message.getAttribute('mesid'));
    return Number.isInteger(id) ? id : null;
  })()`, run.context)
  assert.equal(detect(), 0, 'self-check panel must recognize its own floor, not fail or select the latest floor')
  const next = structuredClone(run.state)
  next.stateRevision = 2
  run.handlers.message({ source: run.parent, data: { type: 'dsh-tavern-helper-context-update', token: 'probe',
    update: client.createTavernHelperContextUpdate(null, next, 1, 2) } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(detect(), 1)
})
