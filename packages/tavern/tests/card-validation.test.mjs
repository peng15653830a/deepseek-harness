import test from 'node:test'
import assert from 'node:assert/strict'
import { validateCardText, validateCardFile } from '../tavern-plugin/lib/domain/card-validation.js'
const check = value => validateCardText(JSON.stringify(value))
test('legacy, V2, V3 and workspace cards preserve unknown extensions', () => {
  const data = { name: '测试', extensions: { custom: { arbitrary: true } } }
  for (const raw of [data, { spec: 'chara_card_v2', data }, { spec: 'chara_card_v3', data }]) {
    assert.equal(check(raw).valid, true)
    assert.equal(check({ kind: 'dsh-tavern-character-workspace', version: 1, raw }).valid, true)
  }
})
test('invalid JSON, card shape and MVU containers report safe locations', () => {
  const invalid = validateCardText('<开局>秘密正文')
  assert.equal(invalid.valid, false)
  assert.doesNotMatch(JSON.stringify(invalid), /秘密正文|<开局>/)
  for (const value of [[], null, { spec: 'chara_card_v3' }, { name: 2 }, { name: 'a', first_mes: [] }, { name: 'a', tags: [1] }, { name: 'a', extensions: { tavern_helper: { variables: [], scripts: {} } } }]) assert.equal(check(value).valid, false)
  assert.match(validateCardText('{\n "name": }').errors[0].message, /第 2 行/)
})
test('validation reads actual file content again after correction', async () => {
  let text = '<开局>'
  const readText = async () => text
  assert.equal((await validateCardFile({ path: 'cards/a.json', readText })).valid, false)
  text = JSON.stringify({ name: '修复后', first_mes: '开场' })
  assert.equal((await validateCardFile({ path: 'cards/a.json', readText })).valid, true)
  assert.equal((await validateCardFile({ path: '', readText })).valid, false)
  assert.equal((await validateCardFile({ path: 'cards/missing.json', readText: async () => undefined })).valid, false)
})

test('production tool reads disk through native DSH schema and rejects play-mode or escaped paths', { skip: !process.env.DSH_BOOT_MODULE }, async t => {
  const { readFile, mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { pathToFileURL } = await import('node:url')
  const { createFileResourceStore, normalizeResourcePath } = await import('../tavern-plugin/lib/domain/file-resources.js')
  const { defineTool } = await import(new URL('../../dsh-tools/lib/index.js', pathToFileURL(process.env.DSH_BOOT_MODULE)))
  const root = await mkdtemp(join(tmpdir(), 'tavern-validate-tool-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const files = createFileResourceStore({ dataRoot: root })
  await files.ensure()
  const path = 'cards/test.json'
  await writeFile(files.absolute(path), '<开局>')
  const source = await readFile(new URL('../tavern-plugin/lib/index.js', import.meta.url), 'utf8')
  const start = source.indexOf("    tools.register(defineTool({\n      name: 'tavern_validate_card'")
  const end = source.indexOf('    tools.register(defineTool({', start + 1)
  let tool, mode = 'card'
  new Function('tools', 'defineTool', 'chatForSession', 'str', 'normalizeResourcePath', 'validateCardFile', 'fileResources', source.slice(start, end))(
    { register(value) { tool = value } }, defineTool, async () => ({ mode, cardPath: path }), value => String(value || ''), normalizeResourcePath, validateCardFile, files)
  const exec = { agent: { session: { id: 'test' } } }
  const broken = await tool.execute({}, exec)
  assert.equal(broken.valid, false)
  assert.ok(tool.output.render({}, broken))
  await writeFile(files.absolute(path), JSON.stringify({ name: '已修复' }))
  assert.equal((await tool.execute({}, exec)).valid, true)
  await assert.rejects(tool.execute({ path: '../private.json' }, exec))
  mode = 'story'
  await assert.rejects(tool.execute({}, exec), /卡片工作台/)
})
