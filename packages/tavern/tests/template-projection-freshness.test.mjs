import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createProfileDataStore } from '../tavern-plugin/lib/profile-data-store.js'
import { createPromptTemplateGlobalVariables } from '../tavern-plugin/lib/domain/prompt-template-global-variables.js'
import { createTavernScriptHostAdapter } from '../tavern-plugin/lib/domain/tavern-script-host-adapter.js'
import { createNativeTemplateConnection } from '../tavern-plugin/lib/vendor/st-prompt-template/host-build/native-connection.js'
import { createTemplateSessionTasks } from '../tavern-plugin/lib/vendor/st-prompt-template/host-build/session-tasks.js'

// Exercise production snapshot/delta and task orchestration with real Profile
// files. The plugin is a deterministic entry probe, not an EJS/browser fixture.
async function fixture(t) {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'template-freshness-'))
  t.after(() => rm(dataRoot, { recursive: true, force: true }))
  const globals = createPromptTemplateGlobalVariables(createProfileDataStore({ dataRoot }))
  await globals.save({ shared: 'before' })
  const cardPath = path.join(dataRoot, 'card.json')
  await writeFile(cardPath, JSON.stringify({ name: 'Test', extensions: { nested: { value: 'before' } } }))
  const chat = {
    id: 'chat', sessionId: 'session', cardPath: 'cards/test.json', mode: 'story',
    _storageRevision: 1, tavernHelperLifecycleRevision: 1,
    variables: {}, messages: [{ role: 'assistant', turn: 1, text: 'opening' }]
  }
  let model = 'before', afterFirst = async () => {}
  const responses = [], seen = []
  const adapter = createTavernScriptHostAdapter({
    resolveChat: async () => structuredClone(chat),
    writeChat: async () => { throw new Error('Unexpected chat write') },
    readCard: async () => JSON.parse(await readFile(cardPath, 'utf8')),
    worldBooks: { bound: async () => null }, scriptDispatch: {},
    globalVariables: globals, modelFor: () => model
  })
  const connection = await createNativeTemplateConnection({
    sessionId: 'session', rpc: async (method, args) => {
      assert.equal(method, 'getFullPromptTemplateState')
      const response = await adapter.readFullPromptTemplateState(args.sessionId, args.cursor)
      responses.push(response)
      return structuredClone(response)
    }
  })
  const tasks = createTemplateSessionTasks({ connection, dispatch: {}, plugin: {
    refresh: async () => {}, dispose: async () => {},
    project: async (_operation, input) => {
      seen.push({
        shared: connection.snapshot.extension_settings.variables.global.shared,
        model: connection.snapshot.dsh.model,
        character: structuredClone(connection.snapshot.characters[0]),
        text: connection.snapshot.chat[0].mes,
        scratch: connection.snapshot.scratch
      })
      if (seen.length === 1) await afterFirst(connection.snapshot)
      return { ok: true, text: input.template, scopes: input.context.scopes }
    }
  } })
  t.after(() => tasks.dispose())
  return {
    dataRoot, cardPath, responses, seen,
    setModel(value) { model = value },
    async run(change) {
      afterFirst = change
      const results = await tasks.project('renderMany', {
        items: [{ template: 'first' }, { template: 'second' }], context: { scopes: {} }
      })
      assert.deepEqual(results.map(result => result.text), ['first', 'second'])
      assert.equal(seen.length, 2, 'each entry executes once')
      assert.ok(responses[1].delta, 'entry reads exercise the production delta protocol')
    }
  }
}

test('批次下一条可见另一存储实例提交的共享变量，无需会话通知', async t => {
  const run = await fixture(t)
  const other = createPromptTemplateGlobalVariables(createProfileDataStore({ dataRoot: run.dataRoot }))
  await run.run(() => other.save({ shared: 'after' }, { shared: 'before' }))
  assert.deepEqual(run.seen.map(value => value.shared), ['before', 'after'])
})

test('批次下一条可见绕过宿主写入路径的 Profile 文件修改', async t => {
  const run = await fixture(t)
  await run.run(() => writeFile(path.join(run.dataRoot, 'prompt-template-variables.json'),
    JSON.stringify({ global: { shared: 'external' } })))
  assert.deepEqual(run.seen.map(value => value.shared), ['before', 'external'])
})

test('聊天 revision 不变时，批次下一条仍重新读取宿主模型', async t => {
  const run = await fixture(t)
  await run.run(async () => run.setModel('after'))
  assert.deepEqual(run.seen.map(value => value.model), ['before', 'after'])
})

test('人物卡投影命中后，批次下一条仍可见外部文件的嵌套变更和删除', async t => {
  const run = await fixture(t)
  await run.run(() => writeFile(run.cardPath, JSON.stringify({ name: 'Changed', extensions: { added: true } })))
  assert.equal(run.seen[0].character.extensions.nested.value, 'before')
  assert.equal(run.seen[1].character.name, 'Changed')
  assert.deepEqual(run.seen[1].character.extensions, { added: true })
  assert.deepEqual(run.seen[1].character.data.extensions, { added: true })
})

test('批次下一条恢复未保存的任意上下文修改，不仅恢复作用域', async t => {
  const run = await fixture(t)
  await run.run(async snapshot => {
    snapshot.chat[0].mes = 'unsaved'
    snapshot.extension_settings.variables.global.shared = 'unsaved'
    snapshot.dsh.model = 'unsaved'
    snapshot.scratch = { temporary: true }
  })
  assert.deepEqual(run.seen[1], run.seen[0])
  assert.equal(run.seen[1].text, 'opening')
  assert.equal(run.seen[1].scratch, undefined)
})
