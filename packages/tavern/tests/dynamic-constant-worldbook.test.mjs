import test from 'node:test'
import assert from 'node:assert/strict'
import { projectWorldBookTemplates } from '../tavern-plugin/lib/domain/worldbook-recall.js'
import { UpstreamTemplateRuntime } from './fixtures/upstream-template-runtime.mjs'
import { createContextPlanner } from '../tavern-plugin/lib/domain/context-planner.js'

const runtime = await UpstreamTemplateRuntime.create()
async function project(entries, variables = {}) {
  return await projectWorldBookTemplates({ includeConstants: true, runtime, worldBook: { view: { entries } }, chat: { variables }, card: { name: '测试' } })
}
test('常驻世界书使用最新开关和 EJS 值，不保留旧内容', async () => {
  const entries = [{ ref: 'dlc', enabled: false, constant: true, content: 'DLC世界' },
    { ref: 'ejs', enabled: true, constant: true, content: '天气：<%= getvar("weather") %>' }]
  assert.doesNotMatch((await project(entries, { weather: '晴' })).context, /DLC世界/)
  entries[0].enabled = true
  const current = await project(entries, { weather: '雨' })
  assert.match(current.context, /DLC世界/)
  assert.match(current.context, /雨/)
  assert.doesNotMatch(current.context, /晴/)
  assert.equal((await project(entries, { weather: '雨' })).context, current.context)
  entries[0].enabled = false
  assert.doesNotMatch((await project(entries)).context, /DLC世界/)
})
test('命定之诗模式：常驻 setvar 供条件条目 getvar 使用，不写入持久变量', async () => {
  const setter = { ref: 'dlc', enabled: true, constant: true, content: '{{setvar::补充::龙姬解封}}' }
  const current = await project([setter])
  const planner = createContextPlanner({ prompt: () => '' })
  const body = await planner.plan({ purpose: 'body', card: {}, chat: { macroState: current.macroState }, worldBookContext: '城市：{{getvar::补充}}' })
  assert.match(body.text, /城市：龙姬解封/)
  setter.enabled = false
  const disabled = await project([setter])
  const next = await planner.plan({ purpose: 'body', card: {}, chat: { macroState: disabled.macroState }, worldBookContext: '城市：{{getvar::补充}}' })
  assert.doesNotMatch(next.text, /龙姬解封/)
})

import { withCurrentWorldbook } from '../tavern-plugin/lib/domain/session-stable-prefix.js'
import { createNativePlayOrchestrationStrategy } from '../tavern-plugin/lib/domain/foreground-orchestration-strategies.js'
test('系统装配替换旧常驻区块，关闭全部后清空，原始快照不变', async () => {
  const snapshot = [{ name: 'tavern:character-card', text: '固定人物' }, { name: 'tavern:constant-worldbook', text: '旧DLC' }]
  const strategy = createNativePlayOrchestrationStrategy({ modeFor: async () => 'story', visibleTools: async () => [], controlledToolNames: new Set() })
  const assembly = await strategy.assembleSystemPrompt({ sections: [], tools: [] }, { sessionId: 'test', fixedSystemSections: withCurrentWorldbook(snapshot, '新DLC') })
  assert.deepEqual(assembly.sections.map(s => s.text), ['【常驻世界书】\n新DLC', '固定人物'])
  assert.deepEqual(withCurrentWorldbook(snapshot, '').map(s => s.text), ['固定人物'])
  assert.equal(snapshot[1].text, '旧DLC')
})

test('世界书版本提示只比较源内容：EJS 动态求值仍逐轮变化，应用新源后继续动态执行', async () => {
  const { createPlayCardSnapshots } = await import('../tavern-plugin/lib/domain/play-card-snapshots.js')
  const { createWorldBookLibrary } = await import('../tavern-plugin/lib/domain/worldbook-library.js')
  const card = { name: '动态人物', character_book: { entries: [
    { id: 0, comment: '天气', enabled: true, constant: true, content: '天气：<%= getvar("weather") %>', keys: [] }
  ] } }
  const worldBooks = createWorldBookLibrary({ normalizePath: p => p, removeStandalone: async () => {}, cards: { read: async () => card }, resources: { bindingForCard: async () => ({ kind: 'default' }) } })
  const snapshots = createPlayCardSnapshots({ worldBooks, planner: createContextPlanner({ prompt: () => '' }) })
  const chat = { id: 'dynamic-update', mode: 'story', cardPath: 'card.json', variables: { weather: '晴' }, messages: [] }
  Object.assign(chat, await snapshots.replacement(chat, card))
  async function render() { return projectWorldBookTemplates({ runtime, includeConstants: true, worldBook: await worldBooks.bound(chat.cardPath, card, chat), chat, card }) }
  assert.match((await render()).foregroundContext, /天气：晴/)
  const before = await snapshots.updateStatus(chat, card)
  assert.equal(before.available, false)
  chat.variables.weather = '雨'
  assert.match((await render()).foregroundContext, /天气：雨/)
  assert.deepEqual(await snapshots.updateStatus(chat, card), before)
  card.character_book.entries[0].content = '新版天气：<%= getvar("weather") %>'
  const update = await snapshots.updateStatus(chat, card)
  assert.equal(update.worldbookChanged, true)
  assert.doesNotMatch((await render()).foregroundContext, /新版/)
  Object.assign(chat, await snapshots.replacement(chat, card, update.digest))
  assert.match((await render()).foregroundContext, /新版天气：雨/)
  chat.variables.weather = '雪'
  assert.match((await render()).foregroundContext, /新版天气：雪/)
  assert.equal((await snapshots.updateStatus(chat, card)).available, false)
})
