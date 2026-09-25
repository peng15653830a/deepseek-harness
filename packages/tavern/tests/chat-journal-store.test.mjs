import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { gunzipSync } from 'node:zlib'

import { createChatJournalStore } from '../tavern-plugin/lib/domain/chat-journal-store.js'

async function temporary() {
  return await mkdtemp(path.join(os.tmpdir(), 'dsh-tavern-chat-journal-'))
}

function bump(store, chatId, mutate, metadata) {
  return store.update(chatId, function (chat) {
    const next = chat === undefined ? { id: chatId, messages: [], _storageRevision: 0 } : chat
    mutate(next)
    next._storageRevision += 1
    return next
  }, metadata)
}

for (const sealed of [false, true]) test(`损坏的新快照从旧快照与日志恢复，sealed=${sealed}`, async t => {
  const root = await temporary()
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = createChatJournalStore({ dataRoot: root, frameLimit: sealed ? 1 : 200 })
  await bump(store, 'chat', chat => { chat.counter = 1 })
  await bump(store, 'chat', chat => { chat.counter = 2 })
  const broken = path.join(root, 'chats/chat/snapshots/000000000002.json')
  await writeFile(broken, '{"id":"chat",')
  const recovered = createChatJournalStore({ dataRoot: root, logger: { warn() {} } })
  assert.equal((await recovered.read('chat')).counter, 2)
  assert.equal((await recovered.readRevision('chat', 2)).counter, 2)
  assert.equal(await readFile(broken, 'utf8'), '{"id":"chat",')
  await bump(recovered, 'chat', chat => { chat.counter++ })
  assert.equal((await createChatJournalStore({ dataRoot: root, logger: { warn() {} } }).read('chat')).counter, 3)
})

for (const broken of [false, true]) test(`半迁移目录仍可读取旧存档并完成迁移，broken=${broken}`, async t => {
  const root = await temporary()
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, 'chats/chat/journals'), { recursive: true })
  await mkdir(path.join(root, 'chats/chat/snapshots'), { recursive: true })
  const legacy = path.join(root, 'chats/chat.json')
  await writeFile(legacy, JSON.stringify({ id: 'chat', _storageRevision: 5, counter: 5 }))
  if (broken) await writeFile(path.join(root, 'chats/chat/snapshots/000000000005.json'), '{')
  const store = createChatJournalStore({ dataRoot: root, logger: { warn() {} } })
  assert.equal((await store.read('chat')).counter, 5)
  // A cached legacy fallback must notice external changes despite the directory.
  await writeFile(legacy, JSON.stringify({ id: 'chat', _storageRevision: 5, counter: 50 }))
  assert.equal((await store.read('chat')).counter, 50)
  await bump(store, 'chat', chat => { chat.counter++ })
  const restarted = createChatJournalStore({ dataRoot: root })
  assert.equal((await restarted.read('chat')).counter, 51)
  assert.equal((await restarted.readRevision('chat', 5)).counter, 50)
  await assert.rejects(access(legacy), { code: 'ENOENT' })
})

test('损坏快照缺少完整重放链时拒绝静默退回旧状态', async t => {
  const root = await temporary()
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = createChatJournalStore({ dataRoot: root, logger: { warn() {} } })
  await bump(store, 'chat', chat => { chat.counter = 1 })
  await writeFile(path.join(root, 'chats/chat/snapshots/000000000003.json'), '{')
  await assert.rejects(store.read('chat'), /snapshot|快照|revision/)
})

for (const compressed of [false, true]) for (const phase of ['create', 'migrate', 'rotate']) test(`快照发布前进程中断可恢复：${phase}, compressed=${compressed}`, { timeout: 10000 }, async t => {
  const root = await temporary()
  t.after(() => rm(root, { recursive: true, force: true }))
  const original = { id: 'chat', _storageRevision: 1, counter: 1 }
  if (compressed) original.payload = '完整历史变量'.repeat(10000)
  await mkdir(path.join(root, 'chats'), { recursive: true })
  if (phase === 'migrate') await writeFile(path.join(root, 'chats/chat.json'), JSON.stringify(original))
  if (phase === 'rotate') await createChatJournalStore({ dataRoot: root }).update('chat', () => original)
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    const rename = fs.rename;
    fs.rename = async (from, to) => {
      if (from.includes('.staging-')) {
        process.send({ staged: from });
        await new Promise(() => {});
      }
      return rename(from, to);
    };
    syncBuiltinESMExports();
    const { createChatJournalStore } = await import(${JSON.stringify(new URL('../tavern-plugin/lib/domain/chat-journal-store.js', import.meta.url).href)});
    await createChatJournalStore({ dataRoot: ${JSON.stringify(root)}, frameLimit: 1 }).update('chat', chat => ({
      id: 'chat', _storageRevision: (chat?._storageRevision || 0) + 1, counter: (chat?.counter || 0) + 1,
      ...(${compressed} ? { payload: '完整历史变量'.repeat(10000) } : {})
    }));
  `], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL') })
  const [message] = await Promise.race([
    once(child, 'message'),
    once(child, 'exit').then(([code]) => { throw new Error('writer exited before staging: ' + code) })
  ])
  const staged = await readFile(message.staged)
  assert.equal(JSON.parse(compressed ? gunzipSync(staged).toString() : staged.toString()).id, 'chat')
  const stopped = once(child, 'exit')
  child.kill('SIGKILL')
  await stopped
  const restarted = createChatJournalStore({ dataRoot: root })
  const recovered = await restarted.read('chat')
  assert.equal(recovered?.counter, phase === 'create' ? undefined : phase === 'rotate' ? 2 : 1)
  await bump(restarted, 'chat', chat => { chat.counter = 9 })
  assert.equal((await createChatJournalStore({ dataRoot: root }).read('chat')).counter, 9)
})

test('首次保存写 snapshot，后续保存只追加 journal', async function (t) {
  const root = await temporary()
  t.after(async function () { await rm(root, { recursive: true, force: true }) })
  const store = createChatJournalStore({ dataRoot: root, now: () => 1000 })
  await bump(store, 'chat-1', function (chat) { chat.posture = '门边' }, { source: 'chat.create' })
  const snapshot = path.join(root, 'chats/chat-1/snapshots/000000000001.json')
  const initial = await readFile(snapshot, 'utf8')
  const initialMtime = (await stat(snapshot)).mtimeMs

  await bump(store, 'chat-1', function (chat) { chat.posture = '窗边' }, { source: 'settlement.commit', operationId: 'op-1' })

  assert.equal(await readFile(snapshot, 'utf8'), initial)
  assert.equal((await stat(snapshot)).mtimeMs, initialMtime)
  assert.equal((await store.read('chat-1')).posture, '窗边')
  const journal = await readFile(path.join(root, 'chats/chat-1/journals/000000000002-open.jsonl'), 'utf8')
  assert.match(journal, /"source":"settlement.commit"/)
  assert.match(journal, /"path":\["posture"\]/)
  assert.doesNotMatch(journal, /"messages":\[\]/)
})

test('重新创建 Store 后从 snapshot 与 journal 重放当前 Chat', async function (t) {
  const root = await temporary()
  t.after(async function () { await rm(root, { recursive: true, force: true }) })
  const first = createChatJournalStore({ dataRoot: root })
  await bump(first, 'chat-1', function (chat) { chat.messages.push({ role: 'user', text: '开门' }) })
  await bump(first, 'chat-1', function (chat) { chat.messages.push({ role: 'assistant', text: '门开了' }) })
  await bump(first, 'chat-1', function (chat) { chat.timeline = { revision: 1 } })

  const restarted = createChatJournalStore({ dataRoot: root })
  const chat = await restarted.read('chat-1')
  assert.deepEqual(chat.messages.map(function (message) { return message.text }), ['开门', '门开了'])
  assert.equal(chat.timeline.revision, 1)
  assert.equal(chat._storageRevision, 3)
  assert.match(await restarted.version('chat-1'), /^journal:000000000001\.json:/)
})

test('旧 Chat 第一次更新时惰性迁移并保留可读备份', async function (t) {
  const root = await temporary()
  t.after(async function () { await rm(root, { recursive: true, force: true }) })
  await mkdir(path.join(root, 'chats'), { recursive: true })
  await writeFile(path.join(root, 'chats/chat-old.json'), JSON.stringify({ id: 'chat-old', messages: [{ text: '旧正文' }], posture: '旧状态', _storageRevision: 4 }))
  const store = createChatJournalStore({ dataRoot: root, now: () => 12345 })
  assert.equal((await store.read('chat-old')).posture, '旧状态')

  await bump(store, 'chat-old', function (chat) { chat.posture = '新状态' }, { source: 'settlement.commit' })

  assert.equal((await store.read('chat-old')).posture, '新状态')
  assert.equal(JSON.parse(await readFile(path.join(root, 'chats/chat-old.legacy-12345.json'), 'utf8')).posture, '旧状态')
  assert.deepEqual(await readdir(path.join(root, 'chats/chat-old/snapshots')), ['000000000004.json'])
})

test('达到 frame 阈值后生成新 snapshot 并封存 journal', async function (t) {
  const root = await temporary()
  t.after(async function () { await rm(root, { recursive: true, force: true }) })
  const store = createChatJournalStore({ dataRoot: root, frameLimit: 2, byteLimit: 999999 })
  await bump(store, 'chat-1', function (chat) { chat.counter = 0 })
  await bump(store, 'chat-1', function (chat) { chat.counter += 1 })
  await bump(store, 'chat-1', function (chat) { chat.counter += 1 })

  assert.deepEqual((await readdir(path.join(root, 'chats/chat-1/snapshots'))).sort(), ['000000000001.json', '000000000003.json'])
  assert.deepEqual(await readdir(path.join(root, 'chats/chat-1/journals')), ['000000000002-000000000003.jsonl'])

  await bump(store, 'chat-1', function (chat) { chat.counter += 1 })
  assert.equal((await store.read('chat-1')).counter, 3)
  assert.match((await readdir(path.join(root, 'chats/chat-1/journals'))).join(','), /000000000004-open\.jsonl/)
})

test('可以按 storage revision 读取历史 Chat', async function (t) {
  const root = await temporary()
  t.after(async function () { await rm(root, { recursive: true, force: true }) })
  const store = createChatJournalStore({ dataRoot: root, frameLimit: 2 })
  await bump(store, 'chat-1', function (chat) { chat.posture = '一' })
  await bump(store, 'chat-1', function (chat) { chat.posture = '二' })
  await bump(store, 'chat-1', function (chat) { chat.posture = '三' })
  await bump(store, 'chat-1', function (chat) { chat.posture = '四' })

  assert.equal((await store.readRevision('chat-1', 2)).posture, '二')
  assert.equal((await store.readRevision('chat-1', 3)).posture, '三')
  assert.equal((await store.readRevision('chat-1', 4)).posture, '四')
})

test('损坏的最后一行被明确警告并保留此前 revision', async function (t) {
  const root = await temporary()
  t.after(async function () { await rm(root, { recursive: true, force: true }) })
  const warnings = []
  const store = createChatJournalStore({ dataRoot: root, logger: { warn(...args) { warnings.push(args.join(' ')) } } })
  await bump(store, 'chat-1', function (chat) { chat.counter = 1 })
  await bump(store, 'chat-1', function (chat) { chat.counter = 2 })
  const journal = path.join(root, 'chats/chat-1/journals/000000000002-open.jsonl')
  await writeFile(journal, (await readFile(journal, 'utf8')) + '{"revision":3')

  const restarted = createChatJournalStore({ dataRoot: root, logger: { warn(...args) { warnings.push(args.join(' ')) } } })
  assert.equal((await restarted.read('chat-1')).counter, 2)
  assert.match(warnings.join('\n'), /尾行损坏/)

  await bump(restarted, 'chat-1', function (chat) { chat.counter = 3 })
  const afterRepair = createChatJournalStore({ dataRoot: root })
  assert.equal((await afterRepair.read('chat-1')).counter, 3)
})

test('journal revision 断档时报告具体文件和期望 revision', async function (t) {
  const root = await temporary()
  t.after(async function () { await rm(root, { recursive: true, force: true }) })
  const store = createChatJournalStore({ dataRoot: root })
  await bump(store, 'chat-1', function (chat) { chat.counter = 1 })
  await bump(store, 'chat-1', function (chat) { chat.counter = 2 })
  const journal = path.join(root, 'chats/chat-1/journals/000000000002-open.jsonl')
  const frame = JSON.parse((await readFile(journal, 'utf8')).trim())
  frame.revision = 4
  await writeFile(journal, JSON.stringify(frame) + '\n')

  await assert.rejects(
    createChatJournalStore({ dataRoot: root }).read('chat-1'),
    function (error) {
      assert.equal(error.code, 'DSH_TAVERN_JOURNAL_GAP')
      assert.match(error.message, /000000000002-open\.jsonl/)
      assert.match(error.message, /期望 2，实际 4/)
      return true
    }
  )
})

test('删除 Chat 会清理 journal 目录和 legacy 备份', async function (t) {
  const root = await temporary()
  t.after(async function () { await rm(root, { recursive: true, force: true }) })
  await mkdir(path.join(root, 'chats'), { recursive: true })
  await writeFile(path.join(root, 'chats/chat-old.json'), JSON.stringify({ id: 'chat-old', _storageRevision: 2 }))
  const store = createChatJournalStore({ dataRoot: root, now: () => 12345 })
  await bump(store, 'chat-old', function (chat) { chat.counter = 1 })
  await store.remove('chat-old')

  await assert.rejects(access(path.join(root, 'chats/chat-old')), { code: 'ENOENT' })
  assert.deepEqual((await readdir(path.join(root, 'chats'))).filter(function (name) { return name.startsWith('chat-old') }), [])
  assert.equal(await store.read('chat-old'), undefined)
})

test('连续小写入的重放只复制一次完整人物卡，历史 revision 保持隔离', async function (t) {
  const root = await temporary()
  t.after(async function () { await rm(root, { recursive: true, force: true }) })
  const store = createChatJournalStore({ dataRoot: root })
  await bump(store, 'chat-large', chat => { chat.cardPayload = 'unchanged-card'.repeat(1000); chat.counter = 0 })
  for (let index = 1; index <= 20; index++) await bump(store, 'chat-large', chat => { chat.counter = index })
  const clone = globalThis.structuredClone
  let fullCopies = 0
  t.mock.method(globalThis, 'structuredClone', function (value, options) {
    if (value?.cardPayload) fullCopies++
    return clone(value, options)
  })
  const latest = await store.read('chat-large')
  assert.equal(latest.counter, 20)
  assert.ok(fullCopies <= 1, `完整人物卡被复制了 ${fullCopies} 次`)
  const historical = await store.readRevision('chat-large', 11)
  assert.equal(historical.counter, 10)
  historical.cardPayload = 'changed locally'
  assert.equal(latest.cardPayload, 'unchanged-card'.repeat(1000))
})

test('相同存储版本复用读取结果，外部写入、删除重建和返回值编辑不会污染缓存', async t => {
  const root=await temporary();t.after(()=>rm(root,{recursive:true,force:true}))
  const store=createChatJournalStore({dataRoot:root})
  await bump(store,'cached',chat=>{chat.cardPayload='CACHE-PAYLOAD';chat.counter=1})
  await store.read('cached')
  const parse=JSON.parse;let parses=0
  t.mock.method(JSON,'parse',function(text,...args){if(String(text).includes('CACHE-PAYLOAD'))parses++;return parse(text,...args)})
  const copy=await store.read('cached');copy.counter=99
  assert.equal((await store.read('cached')).counter,1)
  assert.equal(parses,0,'未变化的聊天不应重新解析完整存档')
  const external=createChatJournalStore({dataRoot:root})
  await bump(external,'cached',chat=>{chat.counter=2})
  assert.equal((await store.read('cached')).counter,2)
  await external.remove('cached')
  assert.equal(await store.read('cached'),undefined)
  await bump(external,'cached',chat=>{chat.counter=3})
  assert.equal((await store.read('cached')).counter,3)
})

test('普通写入后直接复用最新状态，失败或放弃的编辑不污染缓存', async t => {
  const root=await temporary();t.after(()=>rm(root,{recursive:true,force:true}))
  const store=createChatJournalStore({dataRoot:root})
  await bump(store,'write-cache',chat=>{chat.cardPayload='WRITE-CACHE-PAYLOAD';chat.counter=0})
  await store.read('write-cache')
  const saved=await bump(store,'write-cache',chat=>{chat.counter=1})
  saved.counter=999
  const parse=JSON.parse;let parses=0
  t.mock.method(JSON,'parse',function(text,...args){if(String(text).includes('WRITE-CACHE-PAYLOAD'))parses++;return parse(text,...args)})
  assert.equal((await store.read('write-cache')).counter,1)
  assert.equal(parses,0,'写入后读取不应重新解析完整存档')
  await assert.rejects(store.update('write-cache',chat=>{chat.counter=999;throw new Error('abort')}),/abort/)
  const unchanged=await store.update('write-cache',chat=>{chat.counter=999})
  assert.equal(unchanged.counter,1)
  unchanged.counter=999
  assert.equal((await store.read('write-cache')).counter,1)
})

test('压缩快照膨胀超过上限时明确失败，保留原文件', async t => {
  const { gzipSync } = await import('node:zlib')
  const root = await temporary()
  t.after(() => rm(root, { recursive: true, force: true }))
  const dir = path.join(root, 'chats/chat/snapshots')
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, '000000000001.json.gz')
  const bytes = gzipSync(JSON.stringify({ id: 'chat', _storageRevision: 1, text: 'x'.repeat(5000) }))
  await writeFile(file, bytes)
  const store = createChatJournalStore({ dataRoot: root, maxSnapshotBytes: 1024 })
  await assert.rejects(store.read('chat'), { code: 'ERR_BUFFER_TOO_LARGE' })
  assert.deepEqual(await readFile(file), bytes)
})
