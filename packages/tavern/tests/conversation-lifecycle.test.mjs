import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

async function loadExports() {
  const source = await readFile(new URL('../tavern-plugin/lib/client.js', import.meta.url), 'utf8')
  let descriptor
  const sandbox = { window: { __ModuleLoader__: { load(value) { descriptor = value } } }, console }
  vm.runInNewContext(source, sandbox)
  return descriptor.factory(function () { return {} })
}

const client = await loadExports()
const createConversationLifecycleModule = client.createConversationLifecycleModule
const createConversationPrewarmModule = client.createConversationPrewarmModule
const createPlayWorkspaceResolver = client.createPlayWorkspaceResolver

test('没有现成 Workspace 时自动创建 Tavern 资源 Workspace', async function () {
  const calls = []
  const resolveWorkspace = createPlayWorkspaceResolver({
    currentWorkspaceId: function () { return '' },
    resourceRoot: async function () { calls.push('root'); return { path: '/data/resources' } },
    createWorkspace: async function (input) { calls.push(['create', input.path]); return { workspaceId: 'workspace-tavern' } }
  })

  assert.equal(await resolveWorkspace(), 'workspace-tavern')
  assert.deepEqual(calls, ['root', ['create', '/data/resources']])
})

test('预热与正式启动并发解析时只创建一个 Tavern 资源 Workspace', async function () {
  let creates = 0
  const resolveWorkspace = createPlayWorkspaceResolver({
    currentWorkspaceId: function () { return '' },
    resourceRoot: async function () { return { path: '/data/resources' } },
    createWorkspace: async function () { creates += 1; return { workspaceId: 'workspace-tavern' } }
  })

  assert.deepEqual(await Promise.all([resolveWorkspace(), resolveWorkspace()]), ['workspace-tavern', 'workspace-tavern'])
  assert.equal(creates, 1)
})

function harness(overrides = {}) {
  const calls = []
  const adapters = {
    archiveCurrent: async function () { calls.push('archive') },
    resolveWorkspace: async function (request) { calls.push('resolve:' + request.kind); return 'workspace-1' },
    connectWorkspace: async function (workspaceId) { calls.push('connect:' + workspaceId); return 'session-1' },
    waitForSession: async function (sessionId) { calls.push('wait:' + sessionId) },
    ensurePreset: async function (sessionId) { calls.push('preset:' + sessionId) },
    createChat: async function (request, sessionId) { calls.push('chat:' + request.targetMode + ':' + sessionId) },
    rememberPending: function (pending) { calls.push('remember:' + pending.sessionId) },
    finishOpen: async function (pending) { calls.push('open:' + pending.sessionId) }
  }
  return { calls, module: createConversationLifecycleModule(Object.assign(adapters, overrides)) }
}

test('游玩对话通过一个 interface 严格完成创建生命周期', async function () {
  const { calls, module } = harness()
  const result = await module.start({ kind: 'play', targetMode: 'free', card: { path: 'cards/a.json' } })

  assert.deepEqual(calls, [
    'archive', 'resolve:play', 'connect:workspace-1', 'wait:session-1',
    'preset:session-1', 'chat:free:session-1', 'remember:session-1', 'open:session-1'
  ])
  assert.equal(result.sessionId, 'session-1')
  assert.equal(result.pending.targetMode, 'free')
})

test('游玩与卡片工作台把会话类型交给 preset 选择器', async function () {
  const selected = []
  const play = harness({
    ensurePreset: async function (sessionId, request) { selected.push([sessionId, request.kind]) }
  })
  await play.module.start({ kind: 'play', targetMode: 'story' })

  const card = harness({
    ensurePreset: async function (sessionId, request) { selected.push([sessionId, request.kind]) }
  })
  await card.module.start({ kind: 'card', targetMode: 'card' })

  assert.deepEqual(selected, [['session-1', 'play'], ['session-1', 'card']])
})

test('卡片工作台保留任务元数据直到打开完成', async function () {
  let opened
  const { module } = harness({ finishOpen: async function (pending) { opened = pending } })
  const pending = { task: 'extract', label: '从剧本新建人物卡', selectedResources: [{ path: 'a.md' }] }

  await module.start({ kind: 'card', targetMode: 'card', pending })

  assert.equal(opened.sessionId, 'session-1')
  assert.equal(opened.targetMode, 'card')
  assert.equal(opened.task, 'extract')
  assert.equal(opened.label, '从剧本新建人物卡')
  assert.equal(opened.selectedResources.length, 1)
})

test('已预热的游玩 Session 跳过点击后的 Workspace 解析和 Agent 创建', async function () {
  const { calls, module } = harness()

  const result = await module.start({
    kind: 'play', targetMode: 'story', card: { path: 'cards/a.json' }, preparedSessionId: 'session-warm'
  })

  assert.deepEqual(calls, [
    'archive', 'wait:session-warm', 'preset:session-warm',
    'chat:story:session-warm', 'remember:session-warm', 'open:session-warm'
  ])
  assert.equal(result.sessionId, 'session-warm')
})

test('创建失败会标记准确阶段并停止后续副作用', async function () {
  const { calls, module } = harness({
    ensurePreset: async function () { calls.push('preset:failed'); throw new Error('preset unavailable') }
  })

  await assert.rejects(module.start({ kind: 'play', targetMode: 'free' }), function (error) {
    assert.equal(error.phase, '切换到酒馆模式')
    assert.match(error.message, /preset unavailable/)
    return true
  })
  assert.deepEqual(calls, [
    'archive', 'resolve:play', 'connect:workspace-1', 'wait:session-1', 'preset:failed'
  ])
})

function prewarmHarness(overrides = {}) {
  const calls = []
  const reports = []
  const adapters = {
    sessionIds: function () { return [] },
    resolveWorkspace: async function () { calls.push('resolve'); return 'workspace-1' },
    connectWorkspace: async function () { calls.push('connect'); return 'session-warm' },
    archiveSession: async function (sessionId) { calls.push('archive:' + sessionId) },
    report: function (event) { reports.push(event) },
    now: function () { return 100 }
  }
  return { calls, reports, module: createConversationPrewarmModule(Object.assign(adapters, overrides)) }
}

test('游戏准备只解析 Workspace，认领后才创建 Session', async () => {
  const { calls, module } = prewarmHarness()
  await module.begin({ key: 'card' })
  assert.equal(await module.claim('card'), 'workspace-1')
  assert.deepEqual(calls, ['resolve'])
  assert.equal(await module.claim('card'), '')
})

test('取消尚未完成的工作区预热不会创建 Session，也不能再认领', async () => {
  let release
  const { calls, module } = prewarmHarness({ resolveWorkspace: () => new Promise(resolve => { release = resolve }) })
  const pending = module.begin({ key: 'card' })
  await Promise.resolve()
  module.cancel()
  release('workspace-1')
  await pending
  assert.equal(await module.claim('card'), '')
  assert.deepEqual(calls, [])
})

test('反复选择人物卡并取消不会创建或归档任何 Session', async () => {
  const { calls, module } = prewarmHarness()
  for (let i = 0; i < 5; i++) { await module.begin({ key: 'card' + i }); module.cancel() }
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls.filter(item => item === 'connect' || item.startsWith('archive:')).length, 0)
})

test('初始化失败后重试复用已创建 Session', async () => {
  let attempts = 0
  const { calls, module } = harness({ createChat: async () => { if (++attempts === 1) throw new Error('初始化失败') } })
  const request = { kind: 'play', targetMode: 'story' }
  await assert.rejects(module.start(request), /初始化失败/)
  await module.start(request)
  assert.equal(calls.filter(item => item.startsWith('connect:')).length, 1)
})


test('刷新页面后可复用失败 Session，打开失败不重复初始化，成功后下次新建', async () => {
  const values = new Map()
  const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }
  const request = { kind: 'play', targetMode: 'story', card: { path: 'card' }, preparationId: 'preview-1' }
  const first = harness({ attempts: client.createConversationAttemptStore(storage), finishOpen: async () => { throw new Error('打开失败') } })
  await assert.rejects(first.module.start(request), /打开失败/)
  assert.equal(values.size, 1)
  const second = harness({ attempts: client.createConversationAttemptStore(storage) })
  await second.module.start({ ...request, preparationId: 'preview-2' })
  assert.equal(second.calls.some(item => item.startsWith('connect:') || item.startsWith('chat:')), false)
  assert.equal(values.size, 0)
  await second.module.start(request)
  assert.equal(second.calls.filter(item => item.startsWith('connect:')).length, 1)
})

test('同一次开始操作并发触发只创建一条会话', async () => {
  const { module, calls } = harness()
  await Promise.all([module.start({ kind: 'play' }), module.start({ kind: 'play' })])
  assert.equal(calls.filter(item => item.startsWith('connect:')).length, 1)
})
