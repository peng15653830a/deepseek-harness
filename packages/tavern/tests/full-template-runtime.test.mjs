import test from 'node:test'
import assert from 'node:assert/strict'
import { createFullTemplateRuntime } from './fixtures/browser-template-transport.mjs'

test('前后台模板任务按会话串行，返回浏览器结果并支持释放后重连', async () => {
  const runtime = createFullTemplateRuntime({ publishSignal(sessionId) {
    const work = runtime.dispatch.claim(sessionId, 'page', true)
    if (!work.event) return
    runtime.dispatch.start(sessionId, work.event.id, work.leaseToken, 'page')
    setTimeout(() => runtime.dispatch.complete(sessionId, work.event.id, [{ ok: true, text: work.event.args[0].template }], 'page', work.leaseToken), 5)
  } })
  const engine = runtime.forSession('session')
  runtime.dispatch.touch('session', 'page', true)
  assert.deepEqual((await Promise.all([engine.render('front'), engine.render('back')])).map(x => x.text), ['front', 'back'])
  assert.equal(runtime.dispatch.dispose('session', 'other-page'), false)
  assert.equal(runtime.dispatch.dispose('session', 'page'), true)
  assert.equal(runtime.dispatch.touch('session', 'new-page', true), true)
  runtime.dispose()
  assert.equal(runtime.dispatch.status('session').present, false)
})

test('执行器显式释放后，恢复时重派未开始的任务', async () => {
  let offers = 0, executions = 0
  const runtime = createFullTemplateRuntime({ claimTimeoutMs: 100, readyTimeoutMs: 500,
    publishSignal(id) {
      offers++
      if (offers === 1) { runtime.dispatch.dispose(id, 'page'); setTimeout(() => runtime.dispatch.touch(id, 'page', true), 140); return }
      const work = runtime.dispatch.claim(id, 'page', true)
      assert.equal(runtime.dispatch.start(id, work.event.id, work.leaseToken, 'page').started, true)
      executions++
      runtime.dispatch.complete(id, work.event.id, ['recovered'], 'page', work.leaseToken)
    }
  })
  runtime.dispatch.touch('s', 'page', true)
  assert.equal(await runtime.forSession('s').render('x'), 'recovered')
  assert.equal(offers, 2)
  assert.equal(executions, 1)
  runtime.dispose()
})

test('模板已开始执行后超时不自动重跑', async () => {
  let executions = 0
  const runtime = createFullTemplateRuntime({ executionTimeoutMs: 100, publishSignal(id) {
    const work = runtime.dispatch.claim(id, 'page', true)
    runtime.dispatch.start(id, work.event.id, work.leaseToken, 'page')
    executions++
  } })
  runtime.dispatch.touch('s', 'page', true)
  await assert.rejects(runtime.forSession('s').render('x'), /执行超时/)
  assert.equal(executions, 1)
  runtime.dispose()
})

test('初始化失败立即报告具体原因，不等待在线超时', async () => {
  const runtime = createFullTemplateRuntime({ readyTimeoutMs: 500 })
  runtime.dispatch.touch('s', 'page', false, '模板模块加载失败')
  await assert.rejects(runtime.forSession('s').render('x'), /模板模块加载失败/)
  runtime.dispose()
})

test('任务与回执落盘，回执丢失后跨进程重建仍可确认，不再执行', async t => {
  const { mkdtemp, rm, readdir } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { createProfileDataStore } = await import('../tavern-plugin/lib/profile-data-store.js')
  const root = await mkdtemp(join(tmpdir(), 'template-journal-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = createProfileDataStore({ dataRoot: root })
  const runtime = createFullTemplateRuntime({ store, publishSignal() {} })
  runtime.heartbeat('s', 'page', 'ready')
  const output = runtime.forSession('s').render('test')
  let work
  for (let i = 0; i < 100; i++) {
    work = runtime.dispatch.claim('s', 'page', true)
    if (work.event) break
    await new Promise(r => setTimeout(r, 2))
  }
  assert.ok(work.event)
  assert.equal((await runtime.inspect('s')).task.phase, 'queued')
  assert.equal((await readdir(join(root, 'template-work')).catch(error => { if (error.code === 'ENOENT') return []; throw error })).length, 0)
  assert.equal((await runtime.start('s', work.event.id, work.leaseToken, 'page')).started, true)
  const file = 'template-work/' + (await readdir(join(root, 'template-work')))[0]
  assert.equal((await store.readJson(file)).phase, 'executing')
  assert.equal(await runtime.complete('s', work.event.id, ['saved'], 'page', work.leaseToken), true)
  assert.equal(await output, 'saved')
  runtime.dispose()
  const restarted = createFullTemplateRuntime({ store, publishSignal() { throw new Error('must not replay') } })
  assert.equal(await restarted.complete('s', work.event.id, ['saved'], 'page', work.leaseToken), true)
  assert.equal(await restarted.complete('s', work.event.id, ['saved'], 'other', work.leaseToken), false)
  restarted.dispose()
})

test('初始化中的执行器报告未就绪，不谎报用户没打开页面', async () => {
  const runtime = createFullTemplateRuntime({ readyTimeoutMs: 5 })
  runtime.heartbeat('s', 'page', 'initializing')
  await assert.rejects(runtime.forSession('s').render('x'), /尚未就绪.*initializing/)
  runtime.dispose()
})

test('刷新页面释放尚未执行的任务后，以同一任务 ID 重新领取', async () => {
  let offers = 0, firstId
  const runtime = createFullTemplateRuntime({ readyTimeoutMs: 100, publishSignal(id) {
    offers++
    const work = runtime.dispatch.claim(id, offers === 1 ? 'old' : 'new', true)
    if (offers === 1) {
      firstId = work.event.id
      runtime.dispatch.dispose(id, 'old')
      runtime.heartbeat(id, 'new', 'ready')
    } else {
      assert.equal(work.event.id, firstId)
      runtime.dispatch.start(id, work.event.id, work.leaseToken, 'new')
      runtime.dispatch.complete(id, work.event.id, ['ok'], 'new', work.leaseToken)
    }
  } })
  runtime.heartbeat('s', 'old', 'ready')
  assert.equal(await runtime.forSession('s').render('x'), 'ok')
  assert.equal(offers, 2)
  runtime.dispose()
})

test('大输入只用于派发，所有持久化阶段仅记录体积且支持重启确认', async () => {
  const records = new Map(), writes = []
  const store = { readJson: async path => records.get(path), writeJson: async (path, value) => {
    const saved = structuredClone(value); records.set(path, saved); writes.push(saved)
  } }
  const runtime = createFullTemplateRuntime({ store, publishSignal() {} })
  runtime.heartbeat('s', 'page', 'ready')
  const template = '秘密模板'.repeat(100000)
  const output = runtime.forSession('s').render(template)
  let work
  for (let i = 0; i < 100; i++) {
    work = runtime.dispatch.claim('s', 'page', true)
    if (work.event) break
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  assert.equal(work.event.args[0].template, template)
  await runtime.start('s', work.event.id, work.leaseToken, 'page')
  await runtime.complete('s', work.event.id, [{ ok: true, text: '结果' }], 'page', work.leaseToken)
  assert.deepEqual(await output, { ok: true, text: '结果' })
  runtime.dispose()
  assert.deepEqual(writes.map(job => job.phase), ['executing', 'completed'])
  for (const job of writes) {
    assert.equal(job.input, undefined)
    assert.equal(job.inputBytes, Buffer.byteLength(JSON.stringify({ template, context: {} })))
    assert.ok(Buffer.byteLength(JSON.stringify(job)) < 1024)
  }
  const restarted = createFullTemplateRuntime({ store, publishSignal() { throw new Error('must not replay') } })
  assert.equal(await restarted.complete('s', work.event.id, [], 'page', work.leaseToken), true)
  restarted.dispose()
})

test('执行意图持久化完成前不允许执行，排队状态只在内存可见', async () => {
  let release, entered
  const blocked = new Promise(resolve => { release = resolve })
  const writing = new Promise(resolve => { entered = resolve })
  const records = []
  const runtime = createFullTemplateRuntime({ publishSignal() {}, store: {
    readJson: async () => records.at(-1),
    writeJson: async (_path, value) => { if (value.phase === 'executing') { entered(); await blocked } records.push(structuredClone(value)) }
  } })
  runtime.heartbeat('s', 'page', 'ready')
  const result = runtime.forSession('s').render('test')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal((await runtime.inspect('s')).task.phase, 'queued')
  assert.equal(records.length, 0)
  const work = runtime.dispatch.claim('s', 'page', true)
  const start = runtime.start('s', work.event.id, work.leaseToken, 'page')
  await writing
  assert.notEqual(runtime.dispatch.status('s').phase, 'executing')
  release()
  assert.equal((await start).started, true)
  await runtime.complete('s', work.event.id, ['done'], 'page', work.leaseToken)
  assert.equal(await result, 'done')
  assert.deepEqual(records.map(record => record.phase), ['executing', 'completed'])
  runtime.dispose()
})

test('未就绪的排队任务失败仍保留取消诊断', async () => {
  let record
  const runtime = createFullTemplateRuntime({ readyTimeoutMs: 5, publishSignal() {}, store: {
    readJson: async () => record, writeJson: async (_path, value) => { record = structuredClone(value) }
  } })
  await assert.rejects(runtime.forSession('s').render('test'), /等待就绪超时/)
  assert.equal(record.phase, 'cancelled')
  assert.match(record.error, /等待就绪超时/)
  runtime.dispose()
})

async function claimWork(runtime, sessionId = 's') {
  for (let i = 0; i < 100; i++) {
    const work = runtime.dispatch.claim(sessionId, 'page', true)
    if (work.event) return work
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  throw new Error('No template work offered')
}

test('世界书临时渲染零日志读写，回执重传在下一任务期间仍可确认', async () => {
  let reads = 0, writes = 0
  const runtime = createFullTemplateRuntime({ publishSignal() {}, store: {
    readJson: async () => { reads++; return null }, writeJson: async () => { writes++ }
  } })
  runtime.heartbeat('s', 'page', 'ready')
  const engine = runtime.forSession('s')
  const first = engine.renderProjection('first', { scopes: { local: { count: 1 } } })
  const work = await claimWork(runtime)
  assert.equal(work.event.name, 'render')
  assert.equal(work.event.args[0].context.scopes.local.count, 1)
  assert.equal((await runtime.start('s', work.event.id, 'wrong', 'page')).started, false)
  assert.equal((await runtime.start('s', work.event.id, work.leaseToken, 'page')).started, true)
  assert.equal(await runtime.complete('s', work.event.id, ['first'], 'page', work.leaseToken), true)
  assert.equal(await first, 'first')
  const second = engine.renderProjection('second')
  const next = await claimWork(runtime)
  assert.equal(await runtime.complete('s', work.event.id, [], 'page', work.leaseToken), true)
  assert.equal(await runtime.complete('other', work.event.id, [], 'page', work.leaseToken), false)
  assert.equal(await runtime.complete('s', work.event.id, [], 'other', work.leaseToken), false)
  assert.equal(await runtime.complete('s', work.event.id, [], 'page', 'wrong'), false)
  await runtime.start('s', next.event.id, next.leaseToken, 'page')
  await runtime.complete('s', next.event.id, ['second'], 'page', next.leaseToken)
  assert.equal(await second, 'second')
  assert.equal(reads, 0)
  assert.equal(writes, 0)
  runtime.dispose()
})

test('临时渲染超时后不重跑，迟到回执不可完成后续任务，也不写日志', async () => {
  let writes = 0
  const runtime = createFullTemplateRuntime({ executionTimeoutMs: 100, publishSignal() {}, store: {
    readJson: async () => null, writeJson: async () => { writes++ }
  } })
  runtime.heartbeat('s', 'page', 'ready')
  const output = runtime.forSession('s').renderProjection('slow')
  const rejected = assert.rejects(output, /执行超时/)
  const work = await claimWork(runtime)
  await runtime.start('s', work.event.id, work.leaseToken, 'page')
  await rejected
  assert.equal(await runtime.complete('s', work.event.id, ['late'], 'page', work.leaseToken), false)
  assert.equal(writes, 0)
  runtime.dispose()
})

test('重启丢弃临时回执，普通任务仍保存并恢复回执', async () => {
  const records = new Map(), writes = []
  const store = { readJson: async path => records.get(path), writeJson: async (path, job) => {
    records.set(path, structuredClone(job)); writes.push(job.phase)
  } }
  const runtime = createFullTemplateRuntime({ store, publishSignal() {} })
  runtime.heartbeat('s', 'page', 'ready')
  const engine = runtime.forSession('s')
  const output = engine.command('/test')
  const durable = await claimWork(runtime)
  await runtime.start('s', durable.event.id, durable.leaseToken, 'page')
  await runtime.complete('s', durable.event.id, ['saved'], 'page', durable.leaseToken)
  await output
  const projection = engine.renderProjection('temporary')
  const transient = await claimWork(runtime)
  await runtime.start('s', transient.event.id, transient.leaseToken, 'page')
  await runtime.complete('s', transient.event.id, ['temporary'], 'page', transient.leaseToken)
  await projection
  runtime.dispose()
  const restarted = createFullTemplateRuntime({ store, publishSignal() { throw Error('must not replay') } })
  assert.equal(await restarted.complete('s', transient.event.id, [], 'page', transient.leaseToken), false)
  assert.equal(await restarted.complete('s', durable.event.id, [], 'page', durable.leaseToken), true)
  assert.deepEqual(writes, ['executing', 'completed'])
  restarted.dispose()
})

test('durable completion stores a small receipt without result bodies and preserves live output', async () => {
  const files = new Map(), writes = []
  let fail = false
  const store = {
    async readJson(path) { return structuredClone(files.get(path)) },
    async writeJson(path, value) {
      if (fail) throw new Error('disk unavailable')
      writes.push(JSON.stringify(value).length)
      files.set(path, structuredClone(value))
    }
  }
  const runtime = createFullTemplateRuntime({ store, publishSignal() {} })
  runtime.heartbeat('s', 'page', 'ready')
  const pending = runtime.forSession('s').projectRequest({ messages: [] })
  let work
  for (let i = 0; i < 100; i++) {
    work = runtime.dispatch.claim('s', 'page', true)
    if (work.event) break
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  assert.ok(work.event)
  await runtime.start('s', work.event.id, work.leaseToken, 'page')
  const result = { messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(1000000) }] }], system: 'unchanged' }
  fail = true
  await assert.rejects(runtime.complete('s', work.event.id, [result], 'page', work.leaseToken), /disk unavailable/)
  assert.equal((await runtime.inspect('s')).task.phase, 'executing')
  fail = false
  assert.equal(await runtime.complete('s', work.event.id, [result], 'page', work.leaseToken), true)
  assert.deepEqual(await pending, result)
  runtime.dispose()
  const resumed = createFullTemplateRuntime({ store, publishSignal() { assert.fail('must not replay') } })
  assert.equal(await resumed.complete('s', work.event.id, [result], 'page', work.leaseToken), true)
  assert.equal(await resumed.complete('s', work.event.id, [result], 'page', 'wrong'), false)
  resumed.dispose()
  assert.ok(writes.every(size => size < 2000), 'completion must not persist the megabyte result')
})

test('领取超时不清除在线心跳，不误报断连或重复派发', async () => {
  let offers = 0
  const runtime = createFullTemplateRuntime({ claimTimeoutMs: 100, publishSignal() { offers++ } })
  runtime.heartbeat('s', 'page', 'ready')
  const pulse = setInterval(() => runtime.heartbeat('s', 'page', 'ready'), 20)
  try {
    await assert.rejects(runtime.forSession('s').render('x'), error => error.code === 'FULL_TEMPLATE_CLAIM_TIMEOUT' && /仍有有效心跳/.test(error.message))
    assert.equal(runtime.dispatch.status('s').present, true)
    assert.equal(offers, 1)
  } finally { clearInterval(pulse); runtime.dispose() }
})

test('同一任务有效执行确认允许跨越时限等待，手动取消立即结束且不重跑', async () => {
  let work, executions = 0
  const runtime = createFullTemplateRuntime({ executionTimeoutMs: 100, publishSignal(id) {
    work = runtime.dispatch.claim(id, 'page', true)
    runtime.dispatch.start(id, work.event.id, work.leaseToken, 'page')
    executions++
  } })
  runtime.heartbeat('s', 'page', 'ready')
  const output = runtime.forSession('s').render('x')
  const cancelled = assert.rejects(output, /手动取消/)
  const pulse = setInterval(() => { if (work) runtime.heartbeat('s', 'page', 'working', '', { eventId: work.event.id, leaseToken: work.leaseToken }) }, 20)
  try {
    await new Promise(resolve => setTimeout(resolve, 240))
    assert.equal(runtime.dispatch.status('s').phase, 'executing')
    runtime.cancel('s')
    await cancelled
    assert.equal(executions, 1)
  } finally { clearInterval(pulse); runtime.dispose() }
})

test('慢任务持续确认后正常完成；普通页面心跳不能给任务续期', async () => {
  for (const confirmWork of [true, false]) {
    let work
    const runtime = createFullTemplateRuntime({ executionTimeoutMs: 100, publishSignal(id) {
      work = runtime.dispatch.claim(id, 'page', true)
      runtime.dispatch.start(id, work.event.id, work.leaseToken, 'page')
    } })
    runtime.heartbeat('s', 'page', 'ready')
    const output = runtime.forSession('s').render('slow')
    const verdict = confirmWork ? output : assert.rejects(output, /执行超时/)
    const pulse = setInterval(() => runtime.heartbeat('s', 'page', 'ready', '', confirmWork && work ? { eventId: work.event.id, leaseToken: work.leaseToken } : undefined), 20)
    try {
      await new Promise(resolve => setTimeout(resolve, 230))
      if (confirmWork) runtime.dispatch.complete('s', work.event.id, ['done'], 'page', work.leaseToken)
      assert.equal(await verdict, confirmWork ? 'done' : undefined)
    } finally { clearInterval(pulse); runtime.dispose() }
  }
})


test('批量临时任务单次派发、零持久日志，超时后不逐条回退', async () => {
  let offers=0, reads=0
  const runtime=createFullTemplateRuntime({executionTimeoutMs:100,publishSignal(){offers++},store:{
    readJson:async()=>{reads++;return null},writeJson:async()=>assert.fail('transient write')
  }})
  runtime.heartbeat('s','page','ready')
  const items=[{template:'first',randomRef:'a'},{template:'second',randomRef:'b'}]
  const output=runtime.forSession('s').renderProjections(items,{randomSeed:'seed',scopes:{local:{n:1}}})
  const rejected=assert.rejects(output,/执行超时/)
  const work=await claimWork(runtime)
  assert.equal(work.event.name,'renderMany')
  assert.deepEqual(work.event.args[0].items,items)
  await runtime.start('s',work.event.id,work.leaseToken,'page')
  await rejected
  assert.equal(offers,1)
  assert.equal(reads,0)
  assert.equal(await runtime.complete('s',work.event.id,[[]],'page',work.leaseToken),false)
  runtime.dispose()
})
