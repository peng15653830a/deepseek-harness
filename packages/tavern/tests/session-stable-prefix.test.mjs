import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Session } from './fixtures/dsh-session-host.mjs'
import { sessionEvents, appendSessionEvent } from '../tavern-plugin/lib/domain/session-events.js'
import { createSessionStablePrefixStorage, ensureSessionStablePrefix, readSessionStablePrefix, sessionStablePrefixSections } from '../tavern-plugin/lib/domain/session-stable-prefix.js'

const text = '【故事设定 · 人物卡】\n名字: 测试人物\n\n设定: 固定背景\n\n【常驻世界书】\n固定世界'
let messageId = 0
const user = value => ({ id: 'message-' + (++messageId), role: 'user', content: [{ type: 'text', text: value }], source: { kind: 'user' } })
const plugin = value => ({ ...user(value), source: { kind: 'plugin', plugin: 'dsh-tavern' } })

test('固定背景快照只写一次，正文不进入可压缩历史，恢复后仍装配为系统上下文', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tavern-prefix-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  let storage = createSessionStablePrefixStorage(directory)
  let session = Session.create('prefix-test')
  const prefix = await ensureSessionStablePrefix(session, text, storage)
  assert.equal(prefix.message.source.form, 'snapshot')
  assert.deepEqual(prefix.message.source.sections.map(section => section.name), ['tavern:character-card', 'tavern:constant-worldbook'])
  assert.equal(sessionEvents(session).find(e => e.data?.id === prefix.id).type, 'user/message')
  assert.equal(sessionEvents(session)[0].surfaceOp, 'append')
  assert.equal(sessionStablePrefixSections(session).map(s => s.text).join('\n\n'), text)
  const first = session.append('user/message', user('第一轮'), { surfaceOp: 'append' })
  const second = session.append('user/message', user('第二轮'), { surfaceOp: 'append' })
  assert.equal((await ensureSessionStablePrefix(session, '后来改卡不重新注入', storage)).message, prefix.message)
  appendSessionEvent(session, 'user/message', plugin('剧情摘要'), { surfaceOp: { op: 'replace', start: first.seq, end: second.seq }, sourceEventSeqs: [first.seq, second.seq] })
  session = Session.create(session.id, sessionEvents(session), session.header)
  storage = createSessionStablePrefixStorage(directory)
  assert.equal((await ensureSessionStablePrefix(session, '重启不重新注入', storage)).text, text)
  assert.equal(sessionEvents(session).filter(event => event.type === 'dsh-tavern/stable-prefix').length, 0)
  assert.equal(sessionEvents(session).filter(event => event.type === 'user/message' && event.data.id === prefix.id).length, 1)
  assert.equal(sessionStablePrefixSections(session).map(s => s.text).join('\n\n'), text)
})

test('旧外部文件和旧 ignorable 事件只作为迁移来源，提升为标准 Session 消息', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tavern-prefix-legacy-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const storage = createSessionStablePrefixStorage(directory)
  await storage.write('stored', { version: 1, id: 'tavern-session-prefix:stored', text })
  const stored = Session.create('stored')
  await ensureSessionStablePrefix(stored, '不能覆盖', storage)
  assert.equal(readSessionStablePrefix(stored).text, text)

  const legacyEvent = { type: 'dsh-tavern/stable-prefix', seq: 0, time: 1, ignorable: true, data: { version: 1, id: 'tavern-session-prefix:legacy', text } }
  const legacy = Session.create('legacy', [legacyEvent])
  await ensureSessionStablePrefix(legacy, '不能覆盖')
  assert.equal(readSessionStablePrefix(legacy).text, text)
  assert.equal(sessionEvents(legacy).filter(event => event.type === 'user/message').length, 1)
})

test('并发确保固定背景只追加一次并采用首次内容', async () => {
  const session = Session.create('concurrent')
  const values = await Promise.all([ensureSessionStablePrefix(session, text), ensureSessionStablePrefix(session, '不能覆盖')])
  assert.equal(values[0].message, values[1].message)
  assert.equal(values[0].text, text)
  assert.equal(sessionEvents(session).filter(event => event.type === 'user/message').length, 1)
  assert.equal(readSessionStablePrefix(session).message, session.deriveMessages()[0])
})

test('旧背景迁入系统上下文，已压缩的原文也可恢复，迁移不改写事件且幂等', async () => {
  for (const compressed of [false, true]) {
    const session = Session.create('old-' + compressed)
    const original = session.append('user/message', { id: 'tavern-session-prefix:' + session.id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: 'dsh-tavern', form: 'snapshot' } }, { surfaceOp: 'append' })
    if (compressed) appendSessionEvent(session, 'user/message', plugin('旧摘要已经遗漏人物背景'), { surfaceOp: { op: 'replace', start: original.seq, end: original.seq }, sourceEventSeqs: [original.seq] })
    const before = sessionEvents(session).slice()
    await ensureSessionStablePrefix(session, '不可替换原始背景')
    const length = sessionEvents(session).length
    await ensureSessionStablePrefix(session, '仍不可替换')
    assert.equal(sessionEvents(session).length, length)
    assert.deepEqual(sessionEvents(session).slice(0, before.length), before)
    assert.equal(readSessionStablePrefix(session).text, text)
    assert.ok(session.deriveMessages().every(m => !JSON.stringify(m.content).includes('固定背景')))
    const restored = Session.create(session.id, sessionEvents(session), session.header)
    assert.deepEqual(sessionStablePrefixSections(restored), sessionStablePrefixSections(session))
  }
})

test('旧 EJS 背景沿用已求值的开局快照，迁移后不再每轮替换', async () => {
  const session = Session.create('ejs')
  session.append('user/message', { id: 'tavern-session-prefix:ejs', role: 'user', content: [{ type: 'text', text: '<% print(await getwi("资料")) %>' }], source: { kind: 'plugin', plugin: 'dsh-tavern', form: 'snapshot' } }, { surfaceOp: 'append' })
  await ensureSessionStablePrefix(session, '已求值的固定世界书')
  await ensureSessionStablePrefix(session, '后续变化')
  assert.equal(readSessionStablePrefix(session).text, '已求值的固定世界书')
})


test('原生分叉沿用继承事件中的固定背景，不因 Session ID 改变重建背景', async () => {
  const original = Session.create('original')
  await ensureSessionStablePrefix(original, text)
  const fork = Session.create('fork', sessionEvents(original), Session.create('fork').header)
  const before = sessionEvents(fork).length
  await ensureSessionStablePrefix(fork, '后来改卡内容')
  assert.equal(sessionEvents(fork).length, before)
  assert.equal(readSessionStablePrefix(fork).text, text)
})

test('手动更新固定背景保留 200 轮历史，恢复及再次请求使用最新版本', async () => {
  let session = Session.create('updated-card-history')
  await ensureSessionStablePrefix(session, text)
  for (let turn = 1; turn <= 200; turn++) session.append('user/message', user('剧情第 ' + turn + ' 轮'), { surfaceOp: 'append' })
  const history = structuredClone(sessionEvents(session))
  const updated = '【故事设定 · 人物卡】\n修改后的设定'
  await ensureSessionStablePrefix(session, updated, undefined, 1)
  assert.deepEqual(sessionEvents(session).slice(0, history.length), history)
  assert.equal(readSessionStablePrefix(session).text, updated)
  assert.deepEqual(sessionEvents(session).at(-1).data.content, [])
  const count = sessionEvents(session).length
  await ensureSessionStablePrefix(session, '未经确认的其他修改', undefined, 1)
  assert.equal(sessionEvents(session).length, count)
  session = Session.create(session.id, sessionEvents(session), session.header)
  assert.equal(readSessionStablePrefix(session).text, updated)
  await ensureSessionStablePrefix(session, '第二次确认的设定', undefined, 2)
  assert.equal(readSessionStablePrefix(session).text, '第二次确认的设定')
})
