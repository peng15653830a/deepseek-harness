import assert from 'node:assert/strict'
import test from 'node:test'
import { accessSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'
import { createBodyEditor } from '../tavern-plugin/lib/domain/body-editor.js'
import { createRoundHistory } from '../tavern-plugin/lib/domain/round-history.js'
import { installHostSessionPatch } from '../tavern-plugin/lib/domain/host-session-patch.js'

const runtime = process.env.TAVERN_DSH_015_RUNTIME || '/tmp/tavern-session-patch-npm-015.jv9SRv'
const runtimeReady = (() => { try { accessSync(join(runtime, 'package.json')); return true } catch { return false } })()

test('未握手时拒绝编辑、回退和重新生成', async () => {
  const sessionPatch = { replacementAllowed: () => false, blockReason: () => '页面尚未完成会话补丁握手，请刷新后再试' }
  const editor = createBodyEditor({
    chats: { forSession() { throw new Error('不应读取聊天') }, update() {} },
    sessions: { get() {}, flush() {} }, timeline: {}, activity() {}, project() {}, present() {}, sessionPatch,
  })
  await assert.rejects(() => editor.read('session'), /握手/)
  const history = createRoundHistory({
    chats: { read() { throw new Error('不应读取聊天') }, forSession() {}, readCard() {}, readRevision() {}, write() {}, update() {} },
    sessions: { get() {}, getSession() {}, resume() {}, flush() {} },
    scripts: {}, timeline: {}, queueSettlement() {}, cancelSettlement() {}, present() {}, sessionPatch,
  })
  await assert.rejects(() => history.regenerate('chat', '', 'session'), /握手/)
  await assert.rejects(() => history.rollback('session', 'chat'), /握手/)
})

test('0.1.5-rc.2 补丁允许替换，未打补丁的读取仍拒绝，官方文件不变', { skip: !runtimeReady }, async () => {
  const hostRequire = createRequire(join(runtime, 'package.json'))
  const load = name => import(pathToFileURL(hostRequire.resolve(name)).href)
  const { Context } = await load('@deepseek-ai/cordis')
  const { Session } = await load('@deepseek-ai/dsh-session')
  const { default: Jsonl } = await load('@deepseek-ai/dsh-session-persistence-jsonl')
  const { SessionQueryEngine } = await load('@deepseek-ai/dsh-session-query')
  const root = await mkdtemp(join(tmpdir(), 'tavern-host-patch-'))
  const blocked = new Context()
  await blocked.plugin(Jsonl, { root: join(root, 'blocked'), compression: 'none' })
  const open = await blocked.sessionPersistence.create({ id: 'held', version: 3, createdAt: 1, isSeeded: false, delegationDepth: 0, cwd: root })
  const refused = await installHostSessionPatch({ hostRequire, persistence: blocked.sessionPersistence, query: new SessionQueryEngine(blocked) })
  assert.equal(refused.status, 'failed')
  assert.match(refused.reason, /已经打开/)
  await open.close()
  await blocked.fiber.dispose()

  const ctx = new Context()
  await ctx.plugin(Jsonl, { root: join(root, 'ready'), compression: 'none' })
  const query = new SessionQueryEngine(ctx)
  const mismatched = await installHostSessionPatch({
    hostRequire: { resolve: name => name.endsWith('/surface') ? fileURLToPath(import.meta.url) : hostRequire.resolve(name) },
    persistence: ctx.sessionPersistence,
    query,
  })
  assert.equal(mismatched.status, 'failed')
  assert.match(mismatched.reason, /补丁清单不一致/)

  const installed = await installHostSessionPatch({ hostRequire, persistence: ctx.sessionPersistence, query })
  assert.equal(installed.status, 'ready')
  assert.equal(installed.replacementAllowed(), false)
  installed.confirmClient({ protocol: 1, installed: true })
  assert.equal(installed.replacementAllowed(), true)
  assert.equal(await installHostSessionPatch({ hostRequire, persistence: ctx.sessionPersistence, query }), installed)

  const session = Session.create('expanded-probe', undefined, { id: 'expanded-probe', version: 3, createdAt: Date.now(), isSeeded: false, delegationDepth: 0 })
  const assistant = text => ({ turn: 1, step: 1, stream: [], message: { id: 'body-' + text, role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: 'tavern-patch', model: 'fixture' } } })
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('system/message', { turn: 1, step: 1, message: { id: 'system', role: 'system', content: [{ type: 'text', text: 'Stable prefix' }], source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' } } }, { surfaceOp: 'append' })
  session.append('user/message', { id: 'input', role: 'user', content: [{ type: 'text', text: 'Player input' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
  const old = session.append('assistant/message', assistant('original'), { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: 'completed' })
  const edited = session.append('assistant/message', assistant('edited'), { surfaceOp: { op: 'replace', startSeq: old.seq, endSeq: old.seq }, sourceEventSeqs: [old.seq] })
  const writer = await ctx.sessionPersistence.create(session.header)
  try { await writer.append(session.snapshotEvents()); await writer.flush() } finally { await writer.close() }
  const reader = await ctx.sessionPersistence.open(session.id, 'read')
  try {
    const restored = Session.fromRestore(session.id, (await reader.read()).events, reader.header, 0, 'detached')
    assert.equal(restored.deriveMessages().at(-1).content.find(part => part.type === 'text').text, 'edited')
  } finally { await reader.close() }

  function evaluate(source) {
    let exports
    vm.runInNewContext(source, { window: { __ModuleLoader__: { load({ factory }) {
      exports = factory(name => name === '@deepseek-ai/cordis' ? { Service: class {} } : name === '@deepseek-ai/dsh-api-gateway/client' ? { RemoteJournalStream: class {} } : {})
    } } } })
    return exports
  }
  const client = evaluate(await readFile(hostRequire.resolve('@deepseek-ai/dsh-api-session-controller/client'), 'utf8'))
  const patched = evaluate(installed.clientSource)
  const stream = new client.SessionEventStream({ session: { page: async () => ({ ok: true, value: { records: [{ type: 'event', event: edited }], hasMore: false } }) } }, { sessionId: session.id }, { publish() {}, failed() {} })
  await assert.rejects(() => stream.readPage({}, edited.seq), /cannot carry sourceEventSeqs/)
  client.SessionEventStream.prototype.readPage = patched.SessionEventStream.prototype.readPage
  assert.equal((await stream.readPage({}, edited.seq)).records[0].event.type, 'assistant/message')
  assert.equal(createHash('sha256').update(readFileSync(hostRequire.resolve('@deepseek-ai/dsh-session/surface'))).digest('hex'),
    'aad7aaabe6cd9b39ae4cc3b50a2873c9b5d73b69d929051f31b18ecc13647c72')
  await ctx.fiber.dispose()
})
