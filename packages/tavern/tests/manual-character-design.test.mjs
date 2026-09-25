import { createStoryTimeline } from '../tavern-plugin/lib/domain/story-timeline.js'
import { createBackgroundTaskCoordinator } from '../tavern-plugin/lib/domain/background-task-coordinator.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { createManualCharacterDesign } from '../tavern-plugin/lib/domain/manual-character-design.js'

const fields = ['identity', 'narrativeRole', 'coreMotivation', 'innerConflict', 'personality', 'appearance', 'behaviorStyle', 'speechStyle', 'relationships', 'defaultPresentation', 'plotPotential']
const design = { name: '张三', ...Object.fromEntries(fields.map(key => [key, '完整设计内容'])) }
function coordinator(read, write) {
  return createBackgroundTaskCoordinator({ timeline: createStoryTimeline(), store: {
    readChat: async () => structuredClone(read()), writeChat: async chat => write(chat),
    updateChat: async (_id, fn) => { const chat = fn(structuredClone(read())); write(chat); return chat }
  } })
}
function fixture(runAgent) {
  let chat = { id: 'chat', sessionId: 'session', messages: [{ role: 'assistant', text: '正文保持原样', variables: [{ hp: 10 }] }] }
  const tasks = coordinator(() => chat, value => { chat = value })
  const api = createManualCharacterDesign({
    beginTask: value => tasks.begin(value, 'character-design'),
    store: { chatForSession: async () => structuredClone(chat), readCard: async () => ({ name: '人物卡' }),
      updateChat: async (_id, update) => { chat = update(structuredClone(chat)); return chat } },
    runAgent, selection: () => ({ provider: 'fixture', model: 'fixture' })
  })
  return { api, tasks, get: () => structuredClone(chat) }
}
test('手动设计执行一次，成功后保存档案且不改正文变量', async () => {
  let calls = 0
  const run = fixture(async input => {
    calls++
    assert.equal(input.task, 'character-design')
    assert.equal(input.persistent, true)
    assert.equal(input.backgroundTasks.characterDesign, true)
    assert.match(input.system, /skill 加载 character-design/)
    assert.match(input.messages[0].content[0].text, /设计张三/)
    assert.equal(JSON.parse(await input.onToolCall({ name: 'character_design_save', arguments: design })).ok, true)
    assert.equal(run.get().characterDesignDocument, undefined, '完成前不写入正式档案')
  })
  const before = run.get().messages
  await run.api.start({ sessionId: 'session', guidance: '设计张三' })
  await run.api.wait('chat')
  assert.equal(calls, 1)
  assert.equal(run.get().characterDesignTask.status, 'done')
  assert.equal(run.get().characterDesignDocument.characters[0].name, '张三')
  assert.deepEqual(run.get().messages, before)
})
test('模型保存草稿后失败不提交，要求保留且可重试', async () => {
  let fail = true
  const run = fixture(async input => {
    await input.onToolCall({ name: 'character_design_save', arguments: design })
    if (fail) throw new Error('模型连接失败')
  })
  await run.api.start({ sessionId: 'session', guidance: '设计张三' }); await run.api.wait('chat')
  assert.equal(run.get().characterDesignDocument, undefined)
  assert.equal(run.api.project(run.get()).status, 'failed')
  assert.equal(run.get().characterDesignTask.guidance, '设计张三')
  fail = false
  await run.api.start({ sessionId: 'session', guidance: '设计张三' }); await run.api.wait('chat')
  assert.equal(run.get().characterDesignTask.status, 'done')
})
test('重复触发被拒绝，未保存档案时报错，服务重启后不会一直显示运行中', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const run = fixture(() => gate)
  await run.api.start({ sessionId: 'session', guidance: '设计张三' })
  await assert.rejects(run.api.start({ sessionId: 'session', guidance: '设计张三' }), /正在进行/)
  release(); await run.api.wait('chat')
  assert.match(run.get().characterDesignTask.error, /未保存/)
  assert.equal(run.api.project({ id: 'old', characterDesignTask: { status: 'running' } }).status, 'failed')
})

test('设计意见选填，空白输入也能启动并保存人物档案', async () => {
  const run = fixture(async input => {
    assert.equal(JSON.parse(input.messages[0].content[0].text).guidance, '')
    assert.match(input.system, /设计意见留空时/)
    await input.onToolCall({ name: 'character_design_save', arguments: design })
  })
  await run.api.start({ sessionId: 'session', guidance: '   ' })
  await run.api.wait('chat')
  assert.equal(run.get().characterDesignTask.status, 'done')
  assert.equal(run.get().characterDesignDocument.characters[0].name, '张三')
})

test('手动设计先恢复当前页面会话，不使用档案中的旧会话 ID', async () => {
  let restored = false, received
  let chat = { id: 'chat', sessionId: 'old-session', messages: [] }
  const tasks = coordinator(() => chat, value => { chat = value })
  const api = createManualCharacterDesign({
    beginTask: value => tasks.begin(value, 'character-design'),
    store: { chatForSession: async () => chat, readCard: async () => ({}), updateChat: async (_id, fn) => { chat = fn(structuredClone(chat)); return chat } },
    selection: () => ({}),
    ensureSession: async id => { assert.equal(id, 'current-session'); restored = true },
    runAgent: async input => {
      assert.equal(restored, true)
      received = input.sessionId
      await input.onToolCall({ name: 'character_design_save', arguments: design })
    }
  })
  await api.start({ sessionId: 'current-session' }); await api.wait('chat')
  assert.equal(received, 'current-session')
  assert.equal(chat.characterDesignTask.status, 'done')
})

test('设计复用结算绑定的后台会话，结束后候选继续使用同一会话', async () => {
  const run = fixture(async input => {
    assert.equal(input.persistentSessionId, 'shared-background')
    assert.equal(input.persistent, true)
    await input.onPersistentSessionReady('shared-background')
    await input.onToolCall({ name: 'character_design_save', arguments: design })
    return { traceSessionId: 'shared-background', traceBoundary: 20 }
  })
  const settlement = await run.tasks.begin(run.get(), 'settlement')
  await settlement.bindSession('shared-background')
  await settlement.commit({ participant: settlement.participant({ sessionId: 'shared-background', boundary: 10 }) })
  await run.api.start({ sessionId: 'session' }); await run.api.wait('chat')
  assert.equal(run.get().characterDesignTask.status, 'done')
  const candidate = await run.tasks.begin(run.get(), 'candidate')
  assert.equal(candidate.participantRequest.sessionId, 'shared-background')
})

test('后台任务运行时不能启动人物设计，也不调用模型', async () => {
  let calls = 0
  const run = fixture(async () => { calls++ })
  await run.tasks.begin(run.get(), 'candidate')
  await assert.rejects(run.api.start({ sessionId: 'session' }), /后台 Agent 正在执行/)
  assert.equal(calls, 0)
  assert.equal(run.get().characterDesignTask, undefined)
})
