import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { presentWorkspaceInstructions, installWorkspaceInstructionPresentation } from '../tavern-plugin/lib/domain/workspace-instruction-presentation.js'

const intro = 'The following workspace instructions may be relevant to your work. Use them as guidance when applicable. More specific instructions take precedence over broader ones. They do not override system, developer, or direct user instructions.'
const replacement = 'This complete workspace instruction baseline replaces all earlier workspace instruction baselines. '
const wrap = text => '<system-reminder>\n' + text + '\n</system-reminder>'
const message = text => ({ role: 'user', id: 'workspace', source: { kind: 'agent-instructions', baseline: true, changes: [] }, content: [{ type: 'text', text }] })
const textOf = request => request.messages[0].content[0].text

test('removes the envelope, preserves instruction bodies and all Agent capabilities without mutating history', () => {
  const body = 'Instructions from: AGENTS.md\n\n保持人物设定。\n' + intro + '\n<system-reminder>用户示例</system-reminder>'
  const original = { messages: [message(wrap(intro + '\n\n' + body)), { role: 'tool', content: [{ type: 'text', text: 'Skill 内容' }], tool_call_id: 'skill-1' }], tools: [{ name: 'skill' }, { name: 'bash' }], system: '人物卡与 Skill 说明', sessionId: 'card' }
  const snapshot = structuredClone(original)
  const result = presentWorkspaceInstructions(original)
  assert.equal(textOf(result), body)
  assert.equal(result.tools, original.tools)
  assert.equal(result.system, original.system)
  assert.equal(result.messages[1], original.messages[1])
  assert.equal(result.messages[0].source, original.messages[0].source)
  assert.deepEqual(original, snapshot)
  assert.equal(presentWorkspaceInstructions(result), result)
})

test('replacement, removal and truncation still tell the model what is current', () => {
  for (const [input, expected] of [
    [replacement + intro + '\n\nInstructions from: AGENTS.md\n\n新内容', '替换此前全部工作区指令'],
    [replacement + 'No workspace instructions are currently active.', '清空此前全部工作区指令'],
    ['Workspace instruction budget 80 bytes: truncated AGENTS.md\n\nWorkspace instructions were omitted or truncated to fit the configured byte budget.\n\nInstructions from: AGENTS.md\n\n部分内容', '工作区指令有省略或截断']
  ]) {
    const result = presentWorkspaceInstructions({ messages: [message(wrap(input))] })
    assert.ok(textOf(result).includes(expected))
    assert.ok(!textOf(result).includes('<system-reminder>'))
  }
  const removed = message(wrap('Instructions removed: AGENTS.md\n\nThe previously loaded instructions from this file no longer apply.'))
  removed.source.changes = [{ action: 'remove', path: 'AGENTS.md' }]
  assert.equal(textOf(presentWorkspaceInstructions({ messages: [removed] })), '【工作区指令已移除：AGENTS.md】')
})

test('incremental instruction bodies survive shortened scope and update envelopes', () => {
  const item = message(wrap('Additional instructions from: cards/AGENTS.md\n\nThese instructions apply to work under `cards`. Use them as guidance when relevant; more specific instructions take precedence. They do not override system, developer, or direct user instructions.\n\n正文\n\nUpdated instructions from: AGENTS.md\n\nThis file changed after it was loaded. Use the following content instead of the previously loaded instructions from this file.\n\n新正文'))
  item.source.changes = [{ path: 'cards/AGENTS.md', action: 'set' }, { path: 'AGENTS.md', action: 'update' }]
  const output = textOf(presentWorkspaceInstructions({ messages: [item] }))
  assert.equal(output, '【工作区指令：cards/AGENTS.md；作用范围：cards】\n\n正文\n\n【工作区指令已更新，替换此文件旧内容：AGENTS.md】\n\n新正文')
})

test('does not touch user quotes, Skill output, assistant messages, or unknown formats', () => {
  for (const source of [undefined, { kind: 'plugin', plugin: 'skill' }, { kind: 'user' }]) {
    const request = { messages: [{ ...message(wrap(intro)), source }] }
    assert.equal(presentWorkspaceInstructions(request), request)
  }
  for (const item of [{ ...message(wrap(intro)), role: 'assistant' }, message(wrap('Unknown new upstream format')), message('Unframed user contents')]) {
    const request = { messages: [item] }
    assert.equal(presentWorkspaceInstructions(request), request)
  }
})

test('production middleware filters play and background but preserves card agents and unrelated sessions', async () => {
  let middleware
  const delivered = []
  const ctx = { on: (_name, fn) => { middleware = fn }, llm: { stream: request => middleware(request, async function * () { delivered.push(request); yield { type: 'finish' } }) } }
  const source = await readFile(new URL('../tavern-plugin/lib/index.js', import.meta.url), 'utf8')
  const start = source.indexOf('  installWorkspaceInstructionPresentation(ctx,')
  const end = source.indexOf('  installCompactionRequestProjection', start)
  const chats = { story: { mode: 'story' }, script: { mode: 'script' }, legacy: {}, card: { mode: 'card' }, edit: { mode: 'card', cardEditContext: { version: 1 } } }
  vm.runInNewContext(source.slice(start, end), {
    ctx, installWorkspaceInstructionPresentation,
    backgroundAgentRunner: { owns: id => id === 'background' },
    chatForSession: async id => chats[id]
  })
  const sessions = ['story', 'script', 'legacy', 'card', 'edit', 'background', 'unrelated']
  for (const sessionId of sessions) {
    const request = { sessionId, messages: [message(wrap(intro + '\n\nInstructions from: AGENTS.md\n\n正文'))] }
    for await (const chunk of ctx.llm.stream(request)) assert.equal(chunk.type, 'finish')
    assert.equal(delivered.length, sessions.indexOf(sessionId) + 1)
    assert.equal(textOf(delivered.at(-1)).includes(intro), ['card', 'edit', 'unrelated'].includes(sessionId))
  }
})
