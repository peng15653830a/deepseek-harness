// Uses installed DSH packages, but never starts a web server or calls a model.
import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { createTavernSkillModule } from '../tavern-plugin/lib/domain/tavern-skills.js'
import { createTavernSkillProvider } from '../tavern-plugin/lib/domain/tavern-skill-provider.js'

test('真实 preset 共存及重新挂载：检查服务唯一，工具和 Tavern Skill 保留', { skip: !process.env.DSH_BOOT_MODULE }, async (t) => {
  const bootUrl = pathToFileURL(path.resolve(process.env.DSH_BOOT_MODULE))
  const { boot } = await import(bootUrl.href)
  const { createScope } = await import(new URL('../../dsh-scope/lib/index.js', bootUrl))
  const { mountPreset } = await import(new URL('../../dsh-agent-presets/lib/index.js', bootUrl))
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-cordis-mount-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = root
  t.after(() => { if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome })
  const source = await readFile(new URL('../presets/tavern/agent.cordis.yml', import.meta.url), 'utf8')
  const entry = id => source.match(new RegExp('- id: ' + id + '\\n[\\s\\S]*?(?=\\n- id:|$)'))[0]
  const presetDir = path.join(root, 'tavern')
  await mkdir(presetDir)
  await cp(new URL('../presets/tavern/skills/', import.meta.url), path.join(presetDir, 'skills'), { recursive: true })
  const presetPath = path.join(presetDir, 'agent.cordis.yml')
  await writeFile(presetPath, source.replace('./user-tools-bridge/index.js',
    new URL('../presets/tavern/user-tools-bridge/index.js', import.meta.url).href)
    .replace('dsh-tavern-plugin/compaction', new URL('../tavern-plugin/lib/agent-compaction.js', import.meta.url).href))
  const officialPath = path.join(root, 'official.cordis.yml')
  await writeFile(officialPath, entry('tool-cordis'))
  const patch = await readFile(new URL('../tavern-plugin/cordis.patch.yml', import.meta.url), 'utf8')
  const adapter = patch.includes('id: tavern-cordis-inspect')
    ? `- id: tavern-cordis-inspect\n  name: ${new URL('../tavern-plugin/lib/cordis-inspect.js', import.meta.url).href}\n` : ''
  const config = path.join(root, 'host.yml')
  await writeFile(config, ['dsh-system-prompt', 'dsh-tools', 'dsh-agent', 'dsh-skill', 'dsh-cordis-host-runner',
    'dsh-llm', 'dsh-session', 'dsh-session-projection', 'dsh-token-meter', 'dsh-commands']
    .map(name => `- id: ${name}\n  name: ${new URL('../../' + name + '/lib/index.js', bootUrl).href}\n`).join('') + adapter)
  const ctx = await boot('tavern-cordis-test', config)
  t.after(() => ctx.fiber.dispose())
  ctx.baseUrl = bootUrl.href
  const { FileSystemSkillProvider } = await import(new URL('../../dsh-skill-filesystem/lib/index.js', bootUrl))
  const library = createTavernSkillModule({ directory: path.join(root, 'user-skills'), builtInDirectory: path.join(presetDir, 'skills') })
  const disabledByScope = new Map()
  let invalidateSkills
  ctx.skills.registerProvider(control => {
    invalidateSkills = control.invalidate
    const provider = new FileSystemSkillProvider(ctx, control, { includeDefaultRoots: false, customSkillDirs: [path.join(root, 'user-skills')], bundledSkillDir: path.join(presetDir, 'skills'), watch: false })
    t.after(() => provider.dispose())
    t.after(library.subscribe(control.invalidate))
    return createTavernSkillProvider({ providers: [provider], library, enabledFor: (skill, scope) => !(disabledByScope.get(scope.id) || []).includes(skill.name), roleFor: key => key?.id?.startsWith('tavern') ? (key.id.includes('play') ? 'foreground' : key.id.includes('background') ? 'background' : 'card') : null })
  })
  const scopes = []
  const mount = async (id, file) => {
    const key = { id, session: { id, header: { cwd: root } } }
    const scope = createScope(ctx, key)
    scopes.push(scope)
    await mountPreset(scope.ctx, { id, path: file })
    scope.ctx.get('tools').register({
      name: 'marker_' + id.replaceAll('-', '_'), description: 'scope marker',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: value => [{ type: 'text', text: value }] },
      execute: async () => id,
    })
    return { ...scope, key }
  }
  t.after(async () => { for (const scope of scopes) await scope.dispose() })
  const official = await mount('cordis', officialPath)
  const first = await mount('tavern', presetPath)
  const second = await mount('tavern-reloaded', presetPath)
  const verify = async scope => {
    const tool = ctx.tools.get('cordis_inspect_list', scope.key)
    assert.ok(tool)
    const { providers } = await tool.execute({}, {})
    for (const id of ['Service', 'Event', 'Builtin', 'Tool']) {
      assert.equal(providers.filter(provider => provider.id === id).length, 1)
    }
    assert.ok(ctx.tools.get('cordis_define', scope.key))
    assert.ok(ctx.tools.get('skill', scope.key))
    const liveTools = await ctx.cordisInspect.query('host', 'Tool', 'listTools', {}, scope.key, new AbortController().signal)
    assert.ok(liveTools.tools.some(tool => tool.name === 'marker_' + scope.key.id.replaceAll('-', '_')))
    assert.ok(!liveTools.tools.some(tool => tool.name === 'marker_cordis'))
    const skills = await ctx.skills.list({ cwd: root, scope: scope.key })
    assert.ok(skills.some(skill => skill.name === 'card-to-mvu'))
    assert.ok(skills.some(skill => skill.name === 'create-skill'))
  }
  await verify(first)
  const play = await mount('tavern-play', presetPath)
  await library.write({ name: 'dialogue-lesson', purpose: 'writing', description: '争执场景', body: '教学正文只在加载后出现', references: [{ path: 'references/lesson.md', content: '独立教学资料' }] })
  const lookup = { cwd: root, scope: play.key }
  assert.deepEqual((await ctx.skills.list(lookup)).map(skill => skill.name), ['dialogue-lesson'])
  assert.equal((await ctx.skills.list(lookup))[0].content, undefined)
  assert.equal(await ctx.skills.get('create-skill', lookup), undefined)
  assert.equal(await ctx.skills.get('dialogue-lesson', { scope: first.key }), undefined)
  const loader = ctx.tools.get('skill', play.key)
  const loaded = await loader.execute({ name: 'dialogue-lesson' }, { agent: play.key, signal: new AbortController().signal })
  assert.match(loaded.content, /教学正文/)
  const editable = await library.read('dialogue-lesson')
  await library.edit({ name: editable.name, content: editable.content.replace('教学正文只在加载后出现', '编辑后的教学正文') })
  invalidateSkills()
  const edited = await loader.execute({ name: editable.name }, { agent: play.key, signal: new AbortController().signal })
  assert.match(edited.content, /编辑后的教学正文/)
  await assert.rejects(loader.execute({ name: 'create-skill' }, { agent: play.key, signal: new AbortController().signal }))
  disabledByScope.set(play.key.id, ['dialogue-lesson'])
  invalidateSkills()
  assert.deepEqual(await ctx.skills.list(lookup), [])
  await assert.rejects(loader.execute({ name: 'dialogue-lesson' }, { agent: play.key, signal: new AbortController().signal }))
  const anotherPlay = await mount('tavern-play-other', presetPath)
  assert.ok(await ctx.skills.get('dialogue-lesson', { cwd: root, scope: anotherPlay.key }))
  disabledByScope.set(play.key.id, [])
  invalidateSkills()
  assert.ok(await ctx.skills.get('dialogue-lesson', lookup))
  await library.assign('dialogue-lesson', ['card'])
  assert.deepEqual(await ctx.skills.list(lookup), [])
  assert.ok(await ctx.skills.get('dialogue-lesson', { scope: first.key }))
  const background = await mount('tavern-background', presetPath)
  await library.assign('dialogue-lesson', ['foreground', 'background'])
  assert.ok(await ctx.skills.get('dialogue-lesson', { scope: background.key }))
  assert.equal(await ctx.skills.get('create-skill', { scope: background.key }), undefined)
  await library.write({ name: 'manual-lesson', purpose: 'writing', description: '手动', body: '仅手动', modelInvocable: false })
  await assert.rejects(loader.execute({ name: 'manual-lesson' }, { agent: play.key, signal: new AbortController().signal }), /not available for model invocation/)
  await library.assign('dialogue-lesson', [])
  assert.equal(await ctx.skills.get('dialogue-lesson', { scope: background.key }), undefined)
  await background.dispose()
  await play.dispose()
  await anotherPlay.dispose()

  await official.dispose()
  await first.dispose()
  await verify(second)
  await second.dispose()
  assert.equal(ctx.cordisInspect.list().length, 0)
  const fresh = await mount('tavern-new', presetPath)
  const reverseOrder = await mount('cordis', officialPath)
  await verify(fresh)
  await reverseOrder.dispose()
  await verify(fresh)
})
