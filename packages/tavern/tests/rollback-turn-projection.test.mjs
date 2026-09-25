import { foregroundSuppressedTurns, clearFailedTurnSurface, locateRollbackSurface } from '../tavern-plugin/lib/domain/rollback-surface.js'
import { Session } from './fixtures/dsh-session-host.mjs'
import { sessionEvents } from '../tavern-plugin/lib/domain/session-events.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../tavern-plugin/lib/client.js', import.meta.url), 'utf8')
let descriptor
vm.runInNewContext(source, { window: { __ModuleLoader__: { load(value) { descriptor = value } } }, console })
const client = descriptor.factory(() => ({}))

function row(kind, turn, alpha) {
  const attrs = { 'data-chat-flow-kind': kind }
  if (alpha) attrs['data-chat-turn'] = String(turn)
  return {
    style: { display: '' }, previousElementSibling: null,
    getAttribute(name) { return attrs[name] ?? null },
    querySelector(selector) {
      return !alpha && kind === 'turn-tail' && selector === '[data-turn-tail]'
        ? { getAttribute() { return String(turn) } } : null
    }
  }
}

function harness(rows) {
  rows.forEach((row, index) => { row.previousElementSibling = rows[index - 1] ?? null })
  const document = { querySelectorAll(selector) {
    assert.ok(['[data-chat-flow-kind="turn-tail"]', '[data-chat-flow-kind="context"]', '[data-chat-turn]'].includes(selector))
    if (selector === '[data-chat-turn]') return rows.filter(row => row.getAttribute('data-chat-turn'))
    return rows.filter(row => selector === '[data-chat-flow-kind="' + row.getAttribute('data-chat-flow-kind') + '"]')
  } }
  const projection = client.createTurnHistoryProjection({ root: () => document, storage: () => ({ getItem: () => '{}' }) })
  return {
    restore: view => projection.restored('test-session', view),
    applySuppressedDshTurns: turns => projection.apply('test-session', turns),
    applyRegeneration: (turns, regeneratedDshTurns) => projection.apply('test-session', turns, regeneratedDshTurns)
  }
}

for (const alpha of [false, true]) {
  test(`${alpha ? 'alpha' : 'main'} 回退隐藏整轮，包含用户输入之前的系统提示词`, () => {
    const before = ['user', 'assistant-step', 'turn-tail'].map(kind => row(kind, 5, alpha))
    const removed = ['system-prompt', 'user', 'turn-process', 'context', 'assistant-step', 'turn-tail'].map(kind => row(kind, 6, alpha))
    const after = ['system-prompt', 'user', 'assistant-step', 'turn-tail'].map(kind => row(kind, 8, alpha))
    const projection = harness([...before, ...removed, ...after])
    projection.applySuppressedDshTurns([6])
    assert.ok(removed.every(row => row.style.display === 'none'), 'system prompt must disappear with the rolled-back turn')
    assert.ok([...before, ...after].every(row => row.style.display === ''), 'adjacent turns remain unchanged')
    projection.applySuppressedDshTurns([6])
    assert.ok(removed.every(row => row.style.display === 'none'), 'refresh/repeated projection remains stable')
  })

  test(`${alpha ? 'alpha' : 'main'} 首轮或无用户输入的重生成轮也能完整隐藏`, () => {
    const removed = ['system-prompt', 'context', 'assistant-step', 'turn-tail'].map(kind => row(kind, 1, alpha))
    harness(removed).applySuppressedDshTurns([1])
    assert.ok(removed.every(row => row.style.display === 'none'))
  })
}

test('alpha 上一轮尾部未挂载时，仍按明确轮次边界保留上一轮', () => {
  const before = row('assistant-step', 5, true)
  const removed = ['system-prompt', 'user', 'assistant-step', 'turn-tail'].map(kind => row(kind, 6, true))
  harness([before, ...removed]).applySuppressedDshTurns([6])
  assert.equal(before.style.display, '')
  assert.ok(removed.every(row => row.style.display === 'none'))
})

for (const alpha of [false, true]) {
  test(`${alpha ? 'alpha' : 'main'} 重生成保留原玩家输入，并以可见 append 回合承载新正文`, () => {
    const original = ['user', 'assistant-step', 'turn-tail'].map(kind => row(kind, 2, alpha))
    const regenerated = ['user', 'assistant-step', 'turn-tail'].map(kind => row(kind, 3, alpha))
    const projection = harness([...original, ...regenerated])

    projection.applyRegeneration([3], { '2': 3 })

    assert.equal(original[0].style.display, '', '原玩家输入继续可见')
    assert.ok(original.slice(1).every(item => item.style.display === 'none'), '旧正文与旧 turn tail 被隐藏')
    assert.equal(regenerated[0].style.display, 'none', '合成的重新生成指令不展示')
    assert.ok(regenerated.slice(1).every(item => item.style.display === ''), '新的 append 正文不能在生成结束后消失')
  })
}

for (const alpha of [false, true]) test(`${alpha ? 'alpha' : 'main'} 中断残留正文随回退消失，重载后不复现`, () => {
  let session = Session.create('interrupted-rollback')
  const model = { kind: 'model', provider: 'fixture', model: 'fixture' }
  for (const turn of [1, 2, 3]) {
    session.append('turn/start', { turn })
    session.append('user/message', { id: 'u' + turn, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'input' + turn }] }, { surfaceOp: 'append' })
    session.append('assistant/message', { turn, step: 1, stream: [], message: { id: 'a' + turn, role: 'assistant', source: model, content: [{ type: 'text', text: turn === 3 ? '中断时已流出的半截正文' : 'reply' + turn }] } }, { surfaceOp: 'append' })
    session.append('turn/end', { turn, reason: { kind: turn === 3 ? 'aborted' : 'completed' } })
  }
  // Same event sequence as the report: aborted reply -> failed-turn cleanup -> rollback.
  clearFailedTurnSurface({ session, turn: 3 })
  assert.deepEqual(foregroundSuppressedTurns({}, sessionEvents(session)), [], "停止本身保留半截正文，只有回退才隐藏")
  const rollback = locateRollbackSurface({ events: sessionEvents(session), nodes: session.surface.nodes })
  assert.equal(rollback.turn, 2)
  session.append('assistant/message', { turn: 2, step: 1, stream: [], message: { id: 'rollback', role: 'assistant', source: model, content: [] } }, {
    surfaceOp: { op: 'replace', startSeq: rollback.userSeq, endSeq: rollback.endSeq }, sourceEventSeqs: rollback.shadowedSeqs
  })
  for (const reload of [false, true]) {
    if (reload) session = Session.create(session.id, sessionEvents(session), session.header)
    const kept = ['user', 'assistant-step', 'turn-tail'].map(kind => row(kind, 1, alpha))
    const rolled = ['user', 'assistant-step', 'turn-tail'].map(kind => row(kind, 2, alpha))
    const interrupted = ['user', 'assistant-step', 'turn-tail'].map(kind => row(kind, 3, alpha))
    const projection = harness([...kept, ...rolled, ...interrupted])
    const viewTurns = foregroundSuppressedTurns({ suppressedDshTurns: [2] }, sessionEvents(session))
    projection.applySuppressedDshTurns(viewTurns)
    assert.ok(!JSON.stringify(session.deriveMessages()).includes('中断时已流出的半截正文'), '模型上下文已清理')
    assert.ok(rolled.every(item => item.style.display === 'none'), '已提交回合已回退')
    assert.ok(interrupted.every(item => item.style.display === 'none'), '中断的半截正文不应留在界面')
    assert.ok(kept.every(item => item.style.display === ''), '保留回合不受影响')
  }
})

for (const alpha of [false, true]) test(`${alpha ? 'alpha' : 'main'} 撤销回退恢复整轮显示并保留其他回退轮次`, () => {
  const older = ['user', 'assistant-step', 'turn-tail'].map(kind => row(kind, 3, alpha))
  const latest = ['system-prompt', 'user', 'assistant-step', 'turn-tail'].map(kind => row(kind, 4, alpha))
  const projection = harness([...older, ...latest])
  projection.applySuppressedDshTurns([3, 4])
  projection.restore({ undoneRollback: { turn: 4 }, suppressedDshTurns: [3] })
  assert.ok(older.every(item => item.style.display === 'none'))
  assert.ok(latest.every(item => item.style.display === ''))
})

for (const alpha of [false, true]) test(`${alpha ? 'alpha' : 'main'} 撤销后旧显示回调迟到，最新投影仍能恢复正文`, () => {
  const latest = ['system-prompt', 'user', 'assistant-step', 'turn-tail'].map(kind => row(kind, 6, alpha))
  const projection = harness(latest)
  projection.applySuppressedDshTurns([6])
  projection.restore({undoneRollback: {turn: 6}, suppressedDshTurns: []})
  // A MutationObserver callback still holding the old view can arrive before
  // React installs the effect for the restored view.
  projection.applySuppressedDshTurns([6])
  projection.applySuppressedDshTurns([])
  assert.ok(latest.every(item => item.style.display === ''), '最新投影必须撤销旧的隐藏样式')
})
test('撤销隐藏保留宿主原有显示样式和其他隐藏行', () => {
  const rows = ['system-prompt', 'user', 'assistant-step', 'turn-tail'].map(kind => row(kind, 6, true))
  rows[0].style.display = 'none'
  rows[1].style.display = 'flex'
  const projection = harness(rows)
  projection.applySuppressedDshTurns([6])
  projection.applySuppressedDshTurns([6])
  projection.applySuppressedDshTurns([])
  assert.deepEqual(rows.map(item => item.style.display), ['none', 'flex', '', ''])
})

 test('隐藏内部恢复上下文行，保留普通注入及包含标识的正文', () => {
  const internal = row('context', 9, true)
  internal.querySelector = selector => selector === '[data-context-source]' ? { textContent: 'dsh-tavern-surface-restore' } : null
  const normal = row('context', 9, true)
  normal.querySelector = selector => selector === '[data-context-source]' ? { textContent: 'dsh-tavern' } : null
  const body = row('assistant-step', 9, true)
  body.textContent = 'dsh-tavern-surface-restore'
  const projection = harness([body, internal, normal])
  for (let i = 0; i < 2; i++) {
    projection.restore({ undoneRollback: { turn: 9 }, suppressedDshTurns: [] })
    assert.equal(internal.style.display, 'none')
    assert.equal(normal.style.display, '')
    assert.equal(body.style.display, '')
  }
})

test('重生成尾部先挂载时，不能隐藏相邻轮次的玩家输入或正文', () => {
  const previous = ['user', 'assistant-step'].map(kind => row(kind, 2, true))
  const current = ['assistant-step', 'turn-tail'].map(kind => row(kind, 6, true))
  const projection = harness([...previous, ...current])
  projection.applyRegeneration([4, 5, 6], { '3': 6 })
  assert.ok(previous.every(item => item.style.display === ''), '缺少本轮 user 和前轮 tail 时不能越过明确轮次边界')
})

test('隐藏旧正文不能越过明确轮次边界，重生成正文尚未挂载也保留前轮', () => {
  const previous = row('assistant-step', 2, true)
  const tail = row('turn-tail', 3, true)
  harness([previous, tail]).applyRegeneration([6], { '3': 6 })
  assert.equal(previous.style.display, '')
})

 test('被替换的合成轮即使没有尾部，也按明确轮次隐藏', () => {
  const oldAttempt = row('assistant-step', 4, true)
  const newest = row('assistant-step', 6, true)
  harness([oldAttempt, newest]).applyRegeneration([4, 5, 6], { '3': 6 })
  assert.equal(oldAttempt.style.display, 'none')
  assert.equal(newest.style.display, '')
})
