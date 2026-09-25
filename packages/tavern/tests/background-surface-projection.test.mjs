import test from 'node:test'
import assert from 'node:assert/strict'
import { backgroundSuppressedTurns, rewindBackgroundSurface } from '../tavern-plugin/lib/domain/background-surface.js'
test('durable rollback excludes tool and reasoning turns including older rollback records', () => {
  const events = [
    { type: "projection-cache", data: { turn: 1 } },
    { seq: 2959, type: 'turn/end', data: { turn: 2 } },
    { seq: 2964, type: 'user/message', data: { turn: 3 } },
    { seq: 3325, type: 'tool/call', data: { turn: 3 } },
    { seq: 4000, type: 'assistant/message', data: { turn: 4 } },
    { seq: 4257, type: 'tool/call', data: { turn: 5 } },
    { seq: 4262, type: 'assistant/message', data: { turn: 5, message: { content: [] } }, surfaceOp: { op: 'replace', start: 2964, end: 4258 } },
    { seq: 4265, type: 'tool/call', data: { turn: 6 } }
  ]
  assert.deepEqual(backgroundSuppressedTurns(events), [3, 4, 5])
  assert.deepEqual(backgroundSuppressedTurns(events.slice(0, 5)), [])
})

test('reset reuses the session and retains its fixed prefix while removing task context', () => {
  let replacement
  const session = { surface: { nodes: [0, 1, 2] }, events: [
    { seq: 0, type: 'user/message', data: { id: 'tavern-session-prefix:bg' } },
    { seq: 1, type: 'user/message', data: { id: 'task' } },
    { seq: 2, type: 'assistant/message', data: { turn: 1, message: { source: { kind: 'model' } } } }
  ], append(type, data, options) { replacement = options.surfaceOp } }
  assert.equal(rewindBackgroundSurface(session, -1), 2)
  assert.deepEqual(replacement, { op: 'replace', start: 1, end: 2 })
})

test('large background history scans event sequences once instead of once per rollback',()=>{
 let reads=0
 const events=Array.from({length:31564},(_,seq)=>({get seq(){reads++;return seq},type:'tool/call',data:{turn:Math.floor(seq/100)+1}}))
 for(let i=0;i<249;i++)events.push({seq:31564+i,type:'assistant/message',data:{message:{content:[]}},surfaceOp:{op:'replace',startSeq:i*100,endSeq:i*100+99}})
 const result=backgroundSuppressedTurns(events)
 assert.equal(result.length,249)
 assert.ok(reads<31564*4,`sequence inspected ${reads} times`)
})

test('V3 reset preserves replaced system head and fixed prefix in surface order', () => {
  const events = Array.from({ length: 18 }, (_, seq) => ({ seq, type: 'step/end', data: {} }))
  events[5] = { seq: 5, type: 'user/message', data: { id: 'tavern-session-prefix:bg' } }
  events[10] = { seq: 10, type: 'system/message', data: { message: { id: 'system' } } }
  events[15] = { seq: 15, type: 'assistant/message', data: { turn: 1, step: 1, message: { source: { kind: 'model' } } } }
  const writes = []
  const session = { events, surface: { nodes: [10, 5, 11, 12, 15, 17] }, append(type, data, options) { writes.push(options) } }
  assert.equal(rewindBackgroundSurface(session, -1), 4)
  assert.deepEqual(writes, [{ surfaceOp: { op: 'replace', start: 11, end: 17 }, sourceEventSeqs: [11, 12, 15, 17] }])
})
