import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { parse } from 'yaml'

import { createTavernSkillModule, normalizeTavernSkillName } from '../tavern-plugin/lib/domain/tavern-skills.js'

async function harness(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-skills-'))
  t.after(async function () { await rm(root, { recursive: true, force: true }) })
  const user = path.join(root, 'user')
  const builtin = path.join(root, 'builtin')
  return { root, user, builtin, skills: createTavernSkillModule({ directory: user, builtInDirectory: builtin }) }
}

test('Skill 名称拒绝路径与非 kebab-case 内容', () => {
  assert.equal(normalizeTavernSkillName('story-style'), 'story-style')
  assert.throws(() => normalizeTavernSkillName('../escape'), /名称只允许/)
  assert.throws(() => normalizeTavernSkillName('Story_Style'), /名称只允许/)
})

test('保存结构化 Skill 并按调用策略生成 frontmatter', async (t) => {
  const run = await harness(t)
  const saved = await run.skills.write({
    name: 'story-style',
    description: '提炼并应用故事文风。',
    body: '# 工作方式\n\n提炼可观察的语言规律。',
    userInvocable: false
  })

  const content = await readFile(saved.path, 'utf8')
  const meta = parse(content.split('---')[1])
  assert.equal(meta['user-invocable'], false)
  assert.equal(meta.name, 'story-style')
  assert.match(content, /# 工作方式/)
  assert.equal((await run.skills.read('story-style')).source, 'user')
})

test('同名用户 Skill 需要明确覆盖，内置 Skill 永远不可覆盖', async (t) => {
  const run = await harness(t)
  await run.skills.write({ name: 'custom-skill', description: '第一版', body: '第一版正文' })
  await assert.rejects(run.skills.write({ name: 'custom-skill', description: '第二版', body: '第二版正文' }), /明确覆盖/)
  const overwritten = await run.skills.write({ name: 'custom-skill', description: '第二版', body: '第二版正文', overwrite: true })
  assert.equal(overwritten.overwritten, true)
  assert.match(overwritten.content, /第二版正文/)

  const builtIn = path.join(run.builtin, 'reserved-skill')
  await mkdir(builtIn, { recursive: true })
  await writeFile(path.join(builtIn, 'SKILL.md'), 'builtin', 'utf8')
  await assert.rejects(run.skills.write({ name: 'reserved-skill', description: '覆盖', body: '覆盖' }), /内置 Skill 不可覆盖/)
})


test('写作与后台用途默认分配，旧 Skill 保留卡片用途，停用与重新分配可持久化', async t => {
  const { skills, user, builtin } = await harness(t)
  for (const purpose of ['writing', 'background', 'card']) await skills.write({ name: purpose, purpose, description: '用途', body: '步骤' })
  assert.deepEqual((await skills.read('writing')).agents, ['foreground'])
  assert.deepEqual((await skills.read('background')).agents, ['background'])
  assert.deepEqual((await skills.read('card')).agents, ['card'])
  await skills.assign('writing', [])
  assert.deepEqual((await createTavernSkillModule({ directory: user, builtInDirectory: builtin }).read('writing')).agents, [])
  await skills.assign('writing', ['foreground', 'background'])
  assert.equal((await skills.list()).length, 3)
  await assert.rejects(skills.assign('writing', ['unknown']), /用途/)
})

test('参考文件独立于素材，覆盖保留引用，拒绝路径越界与符号链接', async t => {
  const { skills, root, user } = await harness(t)
  const source = path.join(root, 'teaching.md')
  await writeFile(source, '现成教学方法')
  await skills.write({ name: 'dialogue', purpose: 'writing', description: '争执场景', body: '按需读 references/lesson.md', references: [{ path: 'references/lesson.md', content: await readFile(source, 'utf8') }] })
  await rm(source)
  assert.equal(await skills.readReference('dialogue', 'references/lesson.md'), '现成教学方法')
  await skills.write({ name: 'dialogue', description: '新的边界', body: '读 references/lesson.md', overwrite: true })
  assert.equal(await skills.readReference('dialogue', 'references/lesson.md'), '现成教学方法')
  assert.deepEqual((await skills.read('dialogue')).agents, ['foreground'])
  await assert.rejects(skills.readReference('dialogue', 'references/../../secret.md'), /相对/)
  const { symlink } = await import('node:fs/promises')
  await writeFile(source, '外部')
  await symlink(source, path.join(user, 'dialogue', 'references', 'external.md'))
  await assert.rejects(skills.readReference('dialogue', 'references/external.md'), /目录之外/)
  await skills.remove('dialogue')
  assert.equal(await skills.read('dialogue'), null)
})

test('并发创建同名 Skill 只有一个成功，非法参考文件不损坏已有版本', async t => {
  const { skills } = await harness(t)
  const input = { name: 'same', description: '旧', body: '旧正文' }
  const results = await Promise.allSettled([skills.write(input), skills.write(input)])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  await assert.rejects(skills.write({ ...input, body: '新', overwrite: true, references: [{ path: '../escape.md', content: '逃逸' }] }))
  assert.match((await skills.read('same')).content, /旧正文/)
})


test('合法名称 constructor 不与配置对象原型冲突', async t => {
  const { skills } = await harness(t)
  await skills.write({ name: 'constructor', description: '说明', body: '内容' })
  assert.deepEqual((await skills.read('constructor')).agents, ['card'])
})


test('只修改正文保留原有调用策略', async t => {
  const { skills } = await harness(t)
  await skills.write({ name: 'manual', description: '手动', body: '旧', modelInvocable: false, userInvocable: false })
  await skills.write({ name: 'manual', description: '手动', body: '新', overwrite: true })
  const skill = await skills.read('manual')
  assert.equal(skill.modelInvocable, false)
  assert.equal(skill.userInvocable, false)
})

 test('文生图 Skill 可默认分配并独立调整用途', async t => {
  const { skills } = await harness(t)
  await skills.write({ name: 'image-style', description: '绘图风格', body: '组织绘图描述', purpose: 'image' })
  assert.deepEqual((await skills.read('image-style')).agents, ['image'])
  await skills.assign('image-style', ['image', 'foreground'])
  assert.deepEqual((await skills.read('image-style')).agents, ['image', 'foreground'])
})

test('内置 Skill 删除在重启和包更新后仍生效', async t => {
  const { skills, builtin, user } = await harness(t)
  const entry = path.join(builtin, 'built-in', 'SKILL.md')
  await mkdir(path.dirname(entry), { recursive: true })
  await writeFile(entry, '---\nname: built-in\ndescription: test\n---\n内容')
  assert.ok(await skills.read('built-in'))
  await skills.remove('built-in')
  await writeFile(entry, '---\nname: built-in\ndescription: updated\n---\n更新内容')
  const restarted = createTavernSkillModule({ directory: user, builtInDirectory: builtin })
  assert.equal(await restarted.read('built-in'), null)
  assert.equal((await restarted.list()).length, 0)
})

test('去掉内置前缀后继承旧用途与删除记录，新配置优先', async t => {
  const { skills, builtin, user } = await harness(t)
  const entry = path.join(builtin, 'create-skill', 'SKILL.md')
  await mkdir(path.dirname(entry), { recursive: true })
  await mkdir(user, { recursive: true })
  await writeFile(entry, '---\nname: create-skill\ndescription: test\n---\n内容')
  await writeFile(path.join(user, '.assignments.json'), JSON.stringify({ 'tavern-create-skill': ['foreground'] }))
  assert.deepEqual((await skills.read('create-skill')).agents, ['foreground'])
  assert.equal((await skills.read('tavern-create-skill')).name, 'create-skill')
  await skills.assign('create-skill', ['card'])
  assert.deepEqual((await skills.read('create-skill')).agents, ['card'])
  await writeFile(path.join(user, '.assignments.json'), JSON.stringify({ 'tavern-create-skill': null }))
  assert.equal(await skills.read('create-skill'), null)
})

test('旧本局开关名称映射只针对已重命名的内置 Skill', async () => {
  const { canonicalTavernSkillName } = await import('../tavern-plugin/lib/domain/tavern-skills.js')
  assert.deepEqual(['tavern-create-skill', 'tavern-custom'].map(canonicalTavernSkillName), ['create-skill', 'tavern-custom'])
})

test('库内编辑覆盖内置正文和参考，保留原包并持久生效', async t => {
  const run = await harness(t)
  await mkdir(path.join(run.builtin, 'example', 'references'), { recursive: true })
  const original = '---\nname: example\ndescription: original\n---\nOriginal body\n'
  await writeFile(path.join(run.builtin, 'example', 'SKILL.md'), original)
  await writeFile(path.join(run.builtin, 'example', 'references', 'notes.md'), 'old')
  const content = original.replace('original', 'edited').replace('Original body', 'Edited body')
  await run.skills.edit({ name: 'example', content, references: [{ path: 'references/notes.md', content: 'new' }] })
  const fresh = createTavernSkillModule({ directory: run.user, builtInDirectory: run.builtin })
  assert.equal((await fresh.read('example')).content, content)
  assert.equal((await fresh.read('example')).description, 'edited')
  assert.equal(await fresh.readReference('example', 'references/notes.md'), 'new')
  assert.equal(await readFile(path.join(run.builtin, 'example', 'SKILL.md'), 'utf8'), original)
  await assert.rejects(fresh.edit({ name: 'example', content: content.replace('name: example', 'name: other') }))
  assert.equal((await fresh.read('example')).content, content)
})
