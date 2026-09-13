import test from 'node:test'
import assert from 'node:assert/strict'
import { projectWorldBookTemplates } from '../tavern-plugin/lib/domain/worldbook-recall.js'
import { TavernPromptTemplateRuntime } from '../tavern-plugin/lib/domain/tavern-prompt-template-runtime.js'
import { createContextPlanner } from '../tavern-plugin/lib/domain/context-planner.js'

const runtime = await TavernPromptTemplateRuntime.create()
function project(entries, variables = {}) {
  return projectWorldBookTemplates({ includeConstants: true, runtime, worldBook: { view: { entries } }, chat: { variables }, card: { name: '测试' } })
}
test('常驻世界书使用最新开关和 EJS 值，不保留旧内容', () => {
  const entries = [{ ref: 'dlc', enabled: false, constant: true, content: 'DLC世界' },
    { ref: 'ejs', enabled: true, constant: true, content: '天气：<%= getvar("weather") %>' }]
  assert.doesNotMatch(project(entries, { weather: '晴' }).context, /DLC世界/)
  entries[0].enabled = true
  const current = project(entries, { weather: '雨' })
  assert.match(current.context, /DLC世界/)
  assert.match(current.context, /雨/)
  assert.doesNotMatch(current.context, /晴/)
  assert.equal(project(entries, { weather: '雨' }).context, current.context)
  entries[0].enabled = false
  assert.doesNotMatch(project(entries).context, /DLC世界/)
})
test('命定之诗模式：常驻 setvar 供条件条目 getvar 使用，不写入持久变量', async () => {
  const setter = { ref: 'dlc', enabled: true, constant: true, content: '{{setvar::补充::龙姬解封}}' }
  const current = project([setter])
  const planner = createContextPlanner({ prompt: () => '' })
  const body = await planner.plan({ purpose: 'body', card: {}, chat: { macroState: current.macroState }, worldBookContext: '城市：{{getvar::补充}}' })
  assert.match(body.text, /城市：龙姬解封/)
  setter.enabled = false
  const disabled = project([setter])
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
