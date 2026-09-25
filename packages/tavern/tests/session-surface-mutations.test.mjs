import test from 'node:test'
import assert from 'node:assert/strict'
import { replaceSessionSurface, createSessionSurfaceMutator } from '../tavern-plugin/lib/domain/session-surface-mutations.js'
import { readdir, readFile } from 'node:fs/promises'
function fixture() {
  const events = [{seq: 0, type: 'assistant/message', data: {message: {id: 'old'}}}]
  return {events, surface: {nodes: [0]}, append(type, data, intent) {
    const event = {seq: events.length, type, data, ...intent}; events.push(event)
    this.surface.nodes = [event.seq]; return event
  }}
}
const data = {turn: 1, step: 1, message: {id: 'edit-1', role: 'assistant', content: [{type: 'text', text: '新正文'}]}}
const target = {start: 0, end: 0, sourceEventSeqs: [0]}
test('重复提交复用原事件，冲突及失效目标不产生任何追加', () => {
  const session = fixture()
  const first = replaceSessionSurface(session, 'assistant/message', data, target)
  assert.equal(replaceSessionSurface(session, 'assistant/message', structuredClone(data), target), first)
  assert.equal(session.events.length, 2)
  assert.throws(() => replaceSessionSurface(session, 'assistant/message', {...data, turn: 2}, target), /不同内容/)
  assert.throws(() => replaceSessionSurface(session, 'assistant/message', {...data, message: {...data.message, id: 'other'}}, target), /目标已变化/)
  assert.equal(session.events.length, 2)
})
test('来源必须覆盖被替换节点并指向真实事件', () => {
  const session = fixture()
  for (const refs of [[], [1], [0, 99]]) {
    assert.throws(() => replaceSessionSurface(session, 'assistant/message', data, {...target, sourceEventSeqs: refs}), /来源引用/)
    assert.equal(session.events.length, 1)
  }
})
test('业务模块不再直接拼接 Surface replace 操作', async () => {
  const root = new URL('../tavern-plugin/lib/', import.meta.url)
  const files = ['index.js', ...(await readdir(new URL('domain/', root))).filter(name => name.endsWith('.js') && name !== 'session-surface-mutations.js').map(name => 'domain/' + name)]
  for (const file of files) assert.doesNotMatch(await readFile(new URL(file, root), 'utf8'), /surfaceOp:\s*\{\s*op:\s*['"]replace['"]/, file)
})

test('编辑过旧楼层后重生成末轮，来源只需覆盖当前 Surface 中的连续目标', async () => {
  const { planRegenerationSurface } = await import('../tavern-plugin/lib/domain/rollback-surface.js')
  const session = fixture()
  session.events.splice(0, 1, ...Array.from({length: 10}, (_, seq) => ({seq, type: 'assistant/message', data: {message: {id: String(seq), source: {kind: 'model'}}}})))
  // seq 8 replaces an earlier floor; its numeric ID lies inside [5,9], but
  // its position is outside the regeneration span in the current surface.
  session.surface.nodes = [0, 8, 2, 5, 9]
  const plan = planRegenerationSurface({events: session.events, nodes: session.surface.nodes, oldAssistantSeq: 5, eventStart: 9})
  assert.deepEqual(plan.shadowedSeqs, [5, 9])
  assert.doesNotThrow(() => replaceSessionSurface(session, 'assistant/message', data, {...plan, sourceEventSeqs: plan.shadowedSeqs}))
})
test('替换范围按 Surface 位置校验，允许事件序号倒序，拒绝位置倒序', () => {
  const session = fixture()
  session.events.push({seq: 1}, {seq: 2})
  session.surface.nodes = [2, 0, 1]
  assert.throws(() => replaceSessionSurface(session, 'assistant/message', data, {start: 1, end: 2, sourceEventSeqs: [1, 2]}), /目标已变化/)
  assert.doesNotThrow(() => replaceSessionSurface(session, 'assistant/message', data, {start: 2, end: 0, sourceEventSeqs: [2, 0]}))
})

test('计量归属按压缩回放位置检查，拒绝冒用区间外引用和漏掉中间节点', async () => {
  const { isTavernSurfaceEdit } = await import('../tavern-plugin/lib/domain/session-surface-mutations.js')
  const events = Array.from({length:10},(_,seq)=>({seq,type:'assistant/message',data:{message:{id:String(seq),source:{kind:'model'}}}}))
  const session={events,header:{agentPreset:'tavern'},eventAt:seq=>events[seq]}
  const event={seq:10,type:'assistant/message',data:{message:{id:'edit',source:{kind:'model'}}},surfaceOp:{op:'replace',start:2,end:6},sourceEventSeqs:[2,9,6]}
  assert.equal(isTavernSurfaceEdit(session,event,[2,9,6]),true)
  assert.equal(isTavernSurfaceEdit(session,{...event,sourceEventSeqs:[2,6]},[2,9,6]),false)
  assert.equal(isTavernSurfaceEdit(session,{...event,sourceEventSeqs:[2,9,6,4]},[2,9,6]),false)
  assert.equal(isTavernSurfaceEdit(session,event,[6,9,2]),false)
  assert.equal(isTavernSurfaceEdit(session,event),false)
})

test('同一恢复批次索引及时记录新事件，保留重试幂等与冲突校验', () => {
  const session = fixture()
  const mutations = createSessionSurfaceMutator(session)
  const placeholder = mutations.append('user/message', { id: 'placeholder', content: [] }, { surfaceOp: 'append' })
  const range = { start: placeholder.seq, end: placeholder.seq, sourceEventSeqs: [placeholder.seq, 0] }
  const first = mutations.replace('assistant/message', data, range)
  assert.equal(mutations.replace('assistant/message', structuredClone(data), range), first)
  assert.throws(() => mutations.replace('assistant/message', { ...data, turn: 9 }, range), /不同内容/)
  assert.throws(() => mutations.replace('assistant/message', { ...data, message: { ...data.message, id: 'other' } }, { start: first.seq, end: first.seq, sourceEventSeqs: [first.seq, 9999] }), /来源引用/)
  assert.equal(session.events.length, 3)
})
