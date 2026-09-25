import assert from 'node:assert/strict'
import test from 'node:test'
import { createChatPersistence } from '../tavern-plugin/lib/domain/chat-persistence.js'
import { createContextPlanner } from '../tavern-plugin/lib/domain/context-planner.js'
import { createPlayCardSnapshots } from '../tavern-plugin/lib/domain/play-card-snapshots.js'

test('v5 老对话重建完整固定前缀，v7 后续请求和恢复复用快照', async () => {
  const card = { name: '测试人物', description: '固定描述', personality: '固定性格', scenario: '固定场景', mes_example: '固定示例', system_prompt: '逐轮系统指令', post_history_instructions: '逐轮历史后指令' }
  let reads = 0
  const writes = []
  function open() {
    return createPlayCardSnapshots({
      worldBooks: { async bound(path) {
        assert.equal(path, 'cards/测试人物.json')
        return { view: { entries: [
          { constant: true, content: '固定世界设定' },
          { constant: false, content: '动态条目不得进入前缀' },
          { constant: true, comment: '[mvu_update]规则', content: 'MVU规则不得进入前缀' }
        ] } }
      } },
      planner: createContextPlanner({ prompt: () => '' }),
      readCard: async () => { reads++; return card },
      writeChat: async (chat, metadata) => { writes.push({ chat: structuredClone(chat), metadata }) }
    }).ensure
  }
  const chat = { id: 'old-chat', mode: 'story', cardPath: 'cards/测试人物.json', cardContextSnapshotVersion: 5, cardContextSnapshot: '旧前缀缺少描述性格', messages: [{ role: 'assistant', text: '原有剧情' }] }
  const beforeMessages = structuredClone(chat.messages)
  const ensure = open()
  const first = await ensure(chat)
  assert.equal(chat.cardContextSnapshotVersion, 7)
  for (const fixed of ['固定描述', '固定性格', '固定场景', '固定示例', '固定世界设定']) assert.equal(first.split(fixed).length - 1, 1)
  assert.doesNotMatch(first, /旧前缀|逐轮|动态条目|MVU规则/)
  assert.equal(await ensure(chat), first)
  assert.equal(await open()(structuredClone(chat)), first)
  assert.equal(reads, 1)
  assert.equal(writes.length, 1)
  assert.equal(writes[0].metadata.source, 'card-context.snapshot')
  assert.deepEqual(chat.messages, beforeMessages)
})

function fixture() {
  let reads = 0, writes = 0, builds = 0
  let plan = async () => ({ text: '固定背景' })
  let write = async () => {}
  const api = createPlayCardSnapshots({
    worldBooks: { bound: async () => null },
    planner: { async plan(input) { builds++; return plan(input) } },
    readCard: async () => { reads++; return { name: '测试' } },
    writeChat: async (...args) => { writes++; return write(...args) }, logger: { warn() {} }
  })
  return { api, get counts() { return { reads, writes, builds } }, plan(fn) { plan = fn }, write(fn) { write = fn } }
}
const oldChat = () => ({ id: 'chat', mode: 'story', messages: [{ text: '既有剧情' }], cardContextSnapshot: '旧前缀', cardContextSnapshotVersion: 5, _storageRevision: 7 })

test('preparing a new chat does not publish it; card workspace and current snapshots do not rebuild', async () => {
  const h = fixture(), chat = oldChat()
  assert.equal(await h.api.prepare(chat), '固定背景')
  assert.equal(h.counts.writes, 0)
  assert.equal(await h.api.ensure(chat), '固定背景')
  assert.equal(await h.api.ensure({ ...oldChat(), mode: 'card' }), '')
  assert.equal(await h.api.ensure(undefined), '')
  assert.deepEqual(h.counts, { reads: 1, writes: 0, builds: 1 })
  assert.deepEqual(chat.messages, [{ text: '既有剧情' }])
})

test('concurrent readers share one migration and all receive its fields without borrowing another storage revision', async () => {
  const h = fixture(), first = oldChat(), second = oldChat()
  let finish
  h.plan(() => new Promise(resolve => { finish = resolve }))
  h.write(async draft => { draft._storageRevision = 8 })
  const one = h.api.ensure(first), two = h.api.ensure(second)
  await new Promise(resolve => setImmediate(resolve))
  finish({ text: '统一前缀' })
  assert.deepEqual(await Promise.all([one, two]), ['统一前缀', '统一前缀'])
  assert.equal(first.cardContextSnapshotVersion, 7)
  assert.equal(second.cardContextSnapshotVersion, 7)
  assert.equal(first._storageRevision, 8)
  assert.equal(second._storageRevision, 7)
  assert.deepEqual(h.counts, { reads: 1, writes: 1, builds: 1 })
})

test('failed save leaves caller state intact, releases concurrent build and permits retry', async () => {
  const h = fixture(), chat = oldChat(), before = structuredClone(chat)
  h.write(async () => { throw Error('disk full') })
  await assert.rejects(h.api.ensure(chat), /disk full/)
  assert.deepEqual(chat, before)
  h.write(async () => {})
  assert.equal(await h.api.ensure(chat), '固定背景')
  assert.equal(chat.cardContextSnapshotVersion, 7)
  assert.equal(h.counts.writes, 2)
})

test('failed plan is retryable and does not publish or mutate a new chat', async () => {
  const h = fixture(), chat = oldChat(), before = structuredClone(chat)
  h.plan(async () => { throw Error('projection failure') })
  await assert.rejects(h.api.prepare(chat), /projection failure/)
  await assert.rejects(h.api.ensure(chat), /projection failure/)
  assert.deepEqual(chat, before)
  assert.equal(h.counts.writes, 0)
  h.plan(async () => ({ text: '恢复' }))
  assert.equal(await h.api.ensure(chat), '恢复')
})

test('missing worldbook is isolated and a newer saved snapshot is preserved', async () => {
  const warnings = [], plans = [], writes = []
  const api = createPlayCardSnapshots({
    worldBooks: { bound: async () => { throw Error('missing worldbook') } },
    planner: { async plan(input) { plans.push(input); return { text: '人物背景' } } },
    readCard: async () => ({ name: '角色' }), writeChat: async (...args) => writes.push(args),
    logger: { warn: (...args) => warnings.push(args) }
  })
  assert.equal(await api.ensure(oldChat()), '人物背景')
  assert.equal(warnings.length, 1)
  assert.equal(plans[0].worldBookContext, '')
  const current = { ...oldChat(), cardContextSnapshot: '未来版本前缀', cardContextSnapshotVersion: 8 }
  assert.equal(await api.ensure(current), '未来版本前缀')
  assert.equal(current.cardContextSnapshotVersion, 8)
  assert.equal(writes.length, 1)
})

test('snapshot owner exposes the same stable worldbook context to candidate generation', async () => {
  const warnings = []
  const api = createPlayCardSnapshots({
    worldBooks: { async bound(path, card) {
      assert.equal(path, 'cards/test.json')
      assert.equal(card.name, 'Test')
      return { view: { entries: [
        { constant: true, content: 'stable lore' },
        { constant: false, content: 'dynamic lore' }
      ] } }
    } },
    planner: { async plan() { return { text: '' } } },
    readCard: async () => ({ name: 'Test' }),
    writeChat: async () => {},
    logger: { warn: (...args) => warnings.push(args) }
  })
  const chat = { cardPath: 'cards/test.json' }
  assert.equal(await api.constantContext(chat, { name: 'Test' }), 'stable lore')
  assert.equal(warnings.length, 0)
})


test('sanitizing an existing snapshot is not visible until its save succeeds', async () => {
  const h = fixture(), chat = { ...oldChat(), cardContextSnapshotVersion: 7, cardContextSnapshot: '{{literal}}' }
  const before = structuredClone(chat)
  h.write(async () => { throw Error('disk full') })
  await assert.rejects(h.api.ensure(chat), /disk full/)
  assert.deepEqual(chat, before)
  h.write(async () => {})
  assert.equal(await h.api.ensure(chat), 'literal')
  assert.equal(h.counts.builds, 0)
})

test('confirmed preference enters only an explicitly enabled new chat stable prefix', async () => {
  let profileReads = 0
  const api = createPlayCardSnapshots({
    worldBooks: { bound: async () => null },
    planner: { plan: async () => ({ text: '人物卡固定内容' }) },
    readCard: async () => ({ name: '测试人物' }),
    writeChat: async () => {},
    userPreferenceProfile: { async stableContext() {
      profileReads++
      return { revision: 7, text: '【用户已确认的长期偏好】\n偏好慢热但持续推进。' }
    } }
  })
  const disabled = { id: 'disabled', mode: 'story', messages: [], userProfileEnabled: false }
  const enabled = { id: 'enabled', mode: 'story', messages: [], userProfileEnabled: true }
  assert.equal(await api.prepare(disabled), '人物卡固定内容')
  assert.equal(profileReads, 0)
  const text = await api.prepare(enabled)
  assert.match(text, /^【用户已确认的长期偏好】/)
  assert.match(text, /人物卡固定内容/)
  assert.equal(enabled.userProfileRevision, 7)
  assert.equal(profileReads, 1)
})

test('snapshot migration cannot manufacture a past worldbook archive from current files', async () => {
  let captures = 0
  const api = createPlayCardSnapshots({ worldBooks: { bound: async () => ({ view: { entries: [] } }) },
    readCard: async () => ({}), planner: { plan: async () => ({ text: '迁移前缀' }) }, writeChat: async () => {},
    captureSceneWorldbook: async () => { captures++; return { version: 1, digest: 'd'.repeat(64) } } })
  const chat = oldChat()
  await api.ensure(chat)
  assert.equal(captures, 0)
  assert.equal(chat.sceneOpeningWorldbook, undefined)
})

test('migration adopts merged persistence state; another reader retains its baseline for later writes', async () => {
  let stored = { ...oldChat(), posture: '原姿势', customUnknown: { keep: true } }
  const persistence = createChatPersistence({ store: {
    read: async () => structuredClone(stored),
    update: async (_id, fn) => { stored = await fn(structuredClone(stored)); return structuredClone(stored) },
    remove: async () => {}
  } })
  const owner = await persistence.read('chat'), waiter = await persistence.read('chat')
  let finish
  const api = createPlayCardSnapshots({ worldBooks: { bound: async () => null }, readCard: async () => ({}),
    planner: { plan: () => new Promise(resolve => { finish = resolve }) }, writeChat: persistence.write })
  const first = api.ensure(owner), second = api.ensure(waiter)
  await new Promise(resolve => setImmediate(resolve))
  await persistence.update('chat', chat => { chat.posture = '新姿势'; return chat })
  finish({ text: '新版背景' })
  await Promise.all([first, second])
  assert.equal(owner.posture, '新姿势')
  assert.deepEqual(owner.customUnknown, { keep: true })
  assert.equal(waiter._storageRevision, 7)
  waiter.messages.push({ text: '并发读取者继续对话' })
  await persistence.write(waiter)
  assert.equal(stored.posture, '新姿势')
  assert.deepEqual(stored.customUnknown, { keep: true })
  assert.equal(stored.cardContextSnapshot, '新版背景')
  assert.equal(stored.messages.length, 2)
})

test('应用新版只生成背景补丁，保留历史、变量、预设和开局用户画像', async () => {
  const api = createPlayCardSnapshots({
    worldBooks: { bound: async () => null }, planner: createContextPlanner({ prompt: () => '' }),
    readCard: async () => { throw new Error('使用用户确认的卡') },
    writeChat: async () => { throw new Error('准备补丁不能写存档') },
    userPreferenceProfile: { stableContext: async () => { throw new Error('不得更新用户画像') } }
  })
  const chat = { id: 'old', mode: 'story', cardPath: 'cards/test.json', messages: Array.from({ length: 200 }, (_, turn) => ({ turn, text: '历史' })),
    mvu: { stat_data: { health: 12 }, schema: { health: 'number' } }, runtimePresetSnapshot: { name: '原预设' },
    userProfileEnabled: true, userProfileRevision: 3, userProfileContextSnapshot: '【用户已确认的长期偏好】\n原有偏好' }
  const original = structuredClone(chat)
  const patch = await api.replacement(chat, { name: '人物', description: '新版描述' })
  assert.deepEqual(chat, original)
  assert.match(patch.cardContextSnapshot, /新版描述/)
  assert.match(patch.cardContextSnapshot, /原有偏好/)
  assert.equal(patch.userProfileRevision, 3)
  assert.equal(patch.cardContextRevision, 1)
  assert.equal(patch.cardContentDigest.length, 64)
  for (const key of ['messages', 'mvu', 'runtimePresetSnapshot', 'sceneOpeningWorldbook']) assert.equal(Object.hasOwn(patch, key), false)
})

test('游玩中切换画像仅修改固定前缀，保留 200 轮历史、变量与原卡背景', async () => {
  const { Session } = await import('./fixtures/dsh-session-host.mjs')
  const { ensureSessionStablePrefix, sessionStablePrefixSections } = await import('../tavern-plugin/lib/domain/session-stable-prefix.js')
  let preference = { revision: 3, text: '【用户已确认的长期偏好】\n温和叙事' }
  const snapshots = createPlayCardSnapshots({ userPreferenceProfile: { stableContext: async () => preference },
    planner: { plan: () => { throw new Error('切换画像不得重建人物卡背景') } },
    writeChat: () => { throw new Error('补丁不能直接写存档') } })
  let chat = { id: 'profile-toggle', mode: 'story', cardContextSnapshotVersion: 7, cardContextSnapshot: '【故事设定 · 人物卡】\n原卡背景\n\n【常驻世界书】\n原世界书', cardContentDigest: 'old-card',
    userProfileEnabled: false, messages: Array.from({ length: 200 }, (_, turn) => ({ turn, text: '历史' })), variables: { hp: 12 }, mvu: { enabled: true }, runtimePresetSnapshot: { id: 'preset' } }
  const original = structuredClone(chat)
  const session = Session.create('profile-toggle')
  await ensureSessionStablePrefix(session, chat.cardContextSnapshot, undefined, 0)
  const enabled = await snapshots.preferenceReplacement(chat, true)
  assert.deepEqual(chat, original)
  chat = { ...chat, ...enabled }
  await ensureSessionStablePrefix(session, chat.cardContextSnapshot, undefined, chat.cardContextRevision)
  assert.match(sessionStablePrefixSections(session).map(s => s.text).join('\n'), /温和叙事/)
  assert.equal(chat.userProfileRevision, 3)
  assert.equal(chat.cardContextRevision, 1)
  assert.equal(chat.cardContentDigest, 'old-card')
  assert.deepEqual(await snapshots.preferenceReplacement(chat, true), {}, '重复开启不破坏缓存')
  preference = { revision: 4, text: '【用户已确认的长期偏好】\n新的偏好' }
  const disabled = await snapshots.preferenceReplacement(chat, false)
  chat = { ...chat, ...disabled }
  await ensureSessionStablePrefix(session, chat.cardContextSnapshot, undefined, chat.cardContextRevision)
  assert.equal(chat.cardContextSnapshot, original.cardContextSnapshot)
  assert.doesNotMatch(sessionStablePrefixSections(session).map(s => s.text).join('\n'), /温和叙事|新的偏好/)
  assert.equal(chat.userProfileRevision, 0)
  chat = { ...chat, ...await snapshots.preferenceReplacement(chat, true) }
  assert.equal(chat.userProfileRevision, 4)
  assert.equal(chat.cardContextRevision, 3)
  for (const field of ['messages', 'variables', 'mvu', 'runtimePresetSnapshot']) assert.deepEqual(chat[field], original[field])
})

test('未确认画像或快照不一致时拒绝切换，不误删人物卡背景', async () => {
  const snapshots = createPlayCardSnapshots({ userPreferenceProfile: { stableContext: async () => null } })
  await assert.rejects(snapshots.preferenceReplacement({ mode: 'story', cardContextSnapshot: '背景' }, true), /确认用户画像/)
  await assert.rejects(snapshots.preferenceReplacement({ mode: 'card' }, true), /游玩会话/)
  await assert.rejects(snapshots.preferenceReplacement({ mode: 'story', userProfileEnabled: true, cardContextSnapshot: '背景', userProfileContextSnapshot: '不匹配的偏好' }, false), /不一致/)
})

test('switching an enabled game to another named profile replaces only its pinned preference', async () => {
  const snapshots = createPlayCardSnapshots({ userPreferenceProfile: { stableContext: async id => ({ profileId: id, revision: 9, text: '新偏好' }) } })
  const chat = { mode: 'story', userProfileEnabled: true, userProfileId: 'a', userProfileRevision: 4,
    userProfileContextSnapshot: '旧偏好', cardContextSnapshot: '旧偏好\n\n原卡背景', cardContextRevision: 1,
    messages: Array.from({ length: 200 }, (_, turn) => ({ turn })), variables: { hp: 12 } }
  const before = structuredClone(chat)
  const patch = await snapshots.preferenceReplacement(chat, true, 'b')
  assert.equal(patch.userProfileId, 'b')
  assert.equal(patch.cardContextSnapshot, '新偏好\n\n原卡背景')
  assert.equal(patch.cardContextRevision, 2)
  assert.deepEqual(chat, before)
  assert.equal(patch.messages, undefined)
  assert.equal(patch.variables, undefined)
})

test('显式应用新版同步刷新常驻背景、MVU 规则和模板世界书，普通读取仍固定', async () => {
  const { createWorldBookLibrary } = await import('../tavern-plugin/lib/domain/worldbook-library.js')
  const { mvuUpdateRulesFromWorldBook } = await import('../tavern-plugin/lib/domain/worldbook-recall.js')
  const card = { name: '测试', character_book: { entries: [
    { id: 0, comment: '背景', content: '新版背景', constant: true, enabled: true, keys: [] },
    { id: 1, comment: '[mvu_update]变量更新规则', content: '人际关系.人际网络', constant: true, enabled: true, keys: [] }
  ] } }
  let binding = { kind: 'default' }
  const worldBooks = createWorldBookLibrary({ normalizePath: p => p, removeStandalone: async () => {},
    cards: { read: async () => card }, resources: { bindingForCard: async () => binding, readText: async () => JSON.stringify({entries:{0:{uid:0,comment:"独立世界书",content:"独立新版",constant:true,disable:false,key:[]}}}) } })
  const old = structuredClone(card.character_book)
  old.entries[0].content = '旧版背景'
  old.entries[1].content = '人际网络'
  const chat = { id: 'test', mode: 'story', cardPath: 'cards/test.json', cardContextSnapshotVersion: 7,
    cardContextSnapshot: '旧版背景', messages: [{role:'assistant',text:'历史'}], variables: {hp:12},
    openingWorldbookSnapshot: {version:1,source:{kind:'card',cardPath:'cards/test.json'},document:old} }
  const before = structuredClone(chat)
  const api = createPlayCardSnapshots({worldBooks, planner:createContextPlanner({prompt:()=>''}), writeChat:async()=>{throw Error('must not save')}, readCard:async()=>card})
  assert.equal(await api.ensure(chat,card),'旧版背景')
  const patch = await api.replacement(chat,card)
  assert.deepEqual(chat,before)
  assert.match(patch.cardContextSnapshot,/新版背景/)
  const updated = {...chat,...patch}
  assert.match(mvuUpdateRulesFromWorldBook(await worldBooks.bound(chat.cardPath,card,updated)).join('\n'),/人际关系\.人际网络/)
  assert.match(JSON.stringify(await worldBooks.templateSnapshot(chat.cardPath,card,updated)),/人际关系\.人际网络/)
  assert.equal(patch.messages,undefined)
  assert.equal(patch.variables,undefined)
  binding = {kind:'standalone',path:'worldbooks/current.json',available:true}
  const rebound = await api.replacement(chat,card)
  assert.equal(rebound.openingWorldbookSnapshot.source.path,'worldbooks/current.json')
  assert.match(rebound.cardContextSnapshot,/独立新版/)
  binding = {kind:'standalone',path:'worldbooks/missing.json',available:false}
  await assert.rejects(api.replacement(chat,card),/世界书不存在/)
  assert.deepEqual(chat,before,'读取失败不应用部分更新')
  binding = {kind:'none'}
  const removed = await api.replacement(chat,card)
  assert.equal(removed.openingWorldbookSnapshot.document,null)
  assert.equal(await worldBooks.bound(chat.cardPath,card,{...chat,...removed}),null)
})

test('世界书绑定改变也提示更新，确认版本后应用且不修改剧情和变量', async () => {
  const { cardContentDigest } = await import('../tavern-plugin/lib/domain/play-card-snapshots.js')
  const card = { name: '人物', description: '固定背景' }
  let book = null
  const worldBooks = { bound: async (_path, _card, chat) => chat?.openingWorldbookSnapshot?.version === 1
    ? { ...chat.openingWorldbookSnapshot, view: { entries: [] } } : book }
  const api = createPlayCardSnapshots({ worldBooks, planner: createContextPlanner({ prompt: () => '' }), readCard: async () => card, writeChat: async () => {} })
  const chat = { id: 'game', mode: 'story', cardPath: 'cards/a.json', cardContentDigest: cardContentDigest(card),
    openingWorldbookSnapshot: { version: 1, source: null, document: null }, messages: [{ role: 'assistant', text: '原剧情' }], variables: { hp: 12 } }
  assert.equal((await api.updateStatus(chat, card)).available, false)
  book = { source: { kind: 'standalone', path: 'worldbooks/a.json' }, document: { entries: {} }, view: { entries: [] } }
  const status = await api.updateStatus(chat, card)
  assert.equal(status.available, true); assert.equal(status.cardChanged, false); assert.equal(status.worldbookChanged, true)
  const before = structuredClone(chat)
  const patch = await api.replacement(chat, card, status.digest)
  assert.deepEqual(chat, before)
  assert.equal(patch.variables, undefined); assert.equal(patch.messages, undefined)
  assert.equal((await api.updateStatus({ ...chat, ...patch }, card)).available, false)
  book.document.entries.changed = { content: '确认后又修改了' }
  await assert.rejects(api.replacement(chat, card, status.digest), /再次修改/)
  assert.deepEqual(chat, before)
  book = null
  assert.equal((await api.updateStatus({ ...chat, ...patch }, card)).worldbookChanged, true)
})

test('应用后本局脚本修改世界书不冒充资源库更新，库文件缺失也不破坏旧存档', async () => {
  const card = { name: '人物' }
  let missing = false
  const live = { source: { kind: 'standalone', path: 'book.json' }, document: { entries: {} }, view: { entries: [] } }
  const api = createPlayCardSnapshots({ worldBooks: { bound: async () => { if (missing) throw Error('世界书不存在'); return live } }, planner: createContextPlanner({ prompt: () => '' }) })
  const chat = { id: 'game', mode: 'story', cardPath: 'card.json', messages: [] }
  Object.assign(chat, await api.replacement(chat, card))
  chat.openingWorldbookSnapshot.document.entries.local = { content: '仅本局脚本写入' }
  assert.equal((await api.updateStatus(chat, card)).available, false)
  live.document.entries.external = { content: '库里的更新' }
  assert.equal((await api.updateStatus(chat, card)).worldbookChanged, true)
  missing = true
  const before = structuredClone(chat)
  const status = await api.updateStatus(chat, card)
  assert.match(status.error, /世界书不存在/)
  assert.deepEqual(chat, before)
})

test('旧快照无源版本时只比较绑定，不把历史脚本改写误报为资源更新', async () => {
  const { cardContentDigest } = await import('../tavern-plugin/lib/domain/play-card-snapshots.js')
  const card = { name: '旧存档' }
  let source = { kind: 'standalone', path: 'book.json' }
  const api = createPlayCardSnapshots({ worldBooks: { bound: async () => ({ source, document: { entries: {} } }) } })
  const chat = { cardContentDigest: cardContentDigest(card), openingWorldbookSnapshot: {
    version: 1, source: structuredClone(source), document: { entries: { 0: { content: '过去脚本写入的状态' } } }
  } }
  assert.equal((await api.updateStatus(chat, card)).available, false)
  source = { kind: 'standalone', path: 'new-book.json' }
  assert.equal((await api.updateStatus(chat, card)).worldbookChanged, true)
})
