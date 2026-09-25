import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { installWorkspaceInstructionPresentation } from '../tavern-plugin/lib/domain/workspace-instruction-presentation.js'

test('native DSH discovers instructions, loads a real Skill and executes an editing tool after presentation filtering', { skip: !process.env.DSH_BOOT_MODULE, timeout: 30000 }, async t => {
  const bootUrl = pathToFileURL(process.env.DSH_BOOT_MODULE)
  const { boot } = await import(bootUrl.href)
  const { LlmAdapter } = await import(new URL('../../dsh-llm/lib/index.js', bootUrl))
  const root = await mkdtemp(join(tmpdir(), 'tavern-instruction-presentation-'))
  const cwd = process.cwd()
  process.chdir(root)
  t.after(async () => { process.chdir(cwd); await rm(root, { recursive: true, force: true }) })
  await writeFile(join(root, 'AGENTS.md'), '保留工作区正文：编辑后返回结果。')
  const packages = ['dsh-system-prompt', 'dsh-tools', 'dsh-agent', 'dsh-llm', 'dsh-session', 'dsh-session-projection', 'dsh-token-meter', 'dsh-commands', 'dsh-agent-loop', 'dsh-skill', 'dsh-tool-skill', 'dsh-fs-local', 'dsh-agent-instructions']
  const config = join(root, 'host.yml')
  await writeFile(config, packages.map(name => '- id: ' + name + '\n  name: ' + new URL('../../' + name + '/lib/index.js', bootUrl).href + '\n' + (name === 'dsh-agent-instructions' ? '  config:\n    maxBytes: 65536\n    dshHome: ' + root + '\n' : '')).join(''))
  const ctx = await boot('tavern-presentation-native', config)
  t.after(() => ctx.fiber.dispose())
  ctx.baseUrl = bootUrl.href
  installWorkspaceInstructionPresentation(ctx, async () => true)
  ctx.skills.register({ name: 'fixture-edit', source: 'fixture/SKILL.md', description: 'Edit a fixture script', content: '保留 Skill 正文：调用 fixture_edit。' })
  ctx.tools.register({ name: 'fixture_edit', description: 'Edit the fixture script', parameters: { type: 'object', properties: {} }, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, async execute() { await writeFile(join(root, 'script.js'), 'export const edited = true\n'); return '编辑完成' } })
  const requests = []
  class Model extends LlmAdapter {
    async resolveModel(provider, id) { return { provider, id, name: id, context: { contextWindow: 32000 } } }
    async *stream(input) {
      requests.push(structuredClone({ messages: input.messages, tools: input.tools }))
      const step = requests.filter(r => r.messages[0]?.id === input.messages[0]?.id).length
      const block = step === 1 ? { type: 'tool-call', id: 'load-skill', name: 'skill', arguments: '{"name":"fixture-edit"}' }
        : step === 2 ? { type: 'tool-call', id: 'edit-script', name: 'fixture_edit', arguments: '{}' }
          : { type: 'text', text: '完成' }
      yield { type: 'block-start', index: 0, blockType: block.type }
      yield { type: 'block-end', index: 0, block }
      yield { type: 'finish', reason: { kind: step <= 2 ? 'tool-calls' : 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['fixture'], new Model())
  const handle = await ctx.agents.create({ sessionId: 'card', agentOptions: { provider: 'fixture', model: 'text' } })
  t.after(() => handle.dispose())
  handle.agent.followup({ id: 'user-start', role: 'user', source: { kind: 'human' }, content: [{ type: 'text', text: '加载 fixture-edit，然后编辑脚本。' }] })
  await handle.agent.whenIdle()
  assert.equal(requests.length, 3)
  const first = JSON.stringify(requests[0].messages)
  assert.match(first, /保留工作区正文/)
  assert.doesNotMatch(first, /The following workspace instructions/)
  assert.doesNotMatch(JSON.stringify(requests[0].messages.filter(m => m.source?.kind === 'agent-instructions')), /<system-reminder>/)
  assert.ok(requests[0].tools.some(tool => tool.name === 'skill'))
  assert.ok(requests[0].tools.some(tool => tool.name === 'fixture_edit'))
  assert.match(JSON.stringify(requests[1].messages), /保留 Skill 正文/)
  assert.equal(await readFile(join(root, 'script.js'), 'utf8'), 'export const edited = true\n')
  assert.match(JSON.stringify(handle.agent.session.deriveMessages()), /The following workspace instructions/)
})
