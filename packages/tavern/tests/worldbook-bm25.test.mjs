import test from 'node:test'
import assert from 'node:assert/strict'
import { createWorldbookBm25 } from '../tavern-plugin/lib/domain/worldbook-bm25.js'
import { createWorldbookFilter } from '../tavern-plugin/lib/domain/worldbook-filter.js'
const pool = () => Array.from({ length: 30 }, (_, i) => ({ ref: String(i), text: i < 10 ? '四番队 治疗 伤口 医疗' : '沙漠 城市 商人 交易', tokenCost: 500 }))
test('small pools and queries without lexical evidence remain unchanged', () => {
  const shortlist = createWorldbookBm25(), candidates = pool()
  assert.equal(shortlist({ candidates: candidates.slice(0, 3), query: '治疗' }).diagnostics.ran, false)
  assert.equal(shortlist({ candidates, query: '银河飞船' }).candidates, candidates)
  assert.equal(shortlist({ candidates, query: '' }).candidates, candidates)
})
test('rendered changes update scores, edits and deletions do not retain stale corpus statistics', () => {
  const shortlist = createWorldbookBm25(), candidates = pool()
  const before = shortlist({ candidates, query: '治疗伤口' })
  assert.ok(before.candidates.some(item => item.ref === '0'))
  assert.equal(before.candidates.length, 10)
  const edited = candidates.map(item => ({ ...item, text: Number(item.ref) >= 10 ? '治疗伤口' : '商人交易' }))
  const corpus = [{ ref: 'unused', content: '<% sideEffect() %>商人', title: '城市' }]
  const warm = shortlist({ candidates: edited, corpus, query: '治疗伤口' })
  const cold = createWorldbookBm25()({ candidates: edited, corpus, query: '治疗伤口' })
  assert.deepEqual(warm.diagnostics.scores, cold.diagnostics.scores)
  assert.equal(warm.diagnostics.scores[0].ref, '10')
  const shortened = edited.slice(0, 25)
  assert.deepEqual(shortlist({ candidates: shortened, query: '治疗' }).diagnostics.scores,
    createWorldbookBm25()({ candidates: shortened, query: '治疗' }).diagnostics.scores)
})
test('whole long entries and score ties are retained rather than truncated', () => {
  const candidates = pool().map(item => ({ ...item, text: '治疗伤口', tokenCost: 10000 }))
  const result = createWorldbookBm25()({ candidates, query: '治疗伤口' })
  assert.equal(result.candidates.length, 30)
  assert.equal(result.candidates[0], candidates[0])
})
test('Agent still judges after BM25; retrieval tools cannot read dropped candidates', async () => {
  const candidates = pool().map((item, i) => ({ ...item, text: i === 29 ? '卯之花治疗伤口' : '无关资料', tokenCost: 9000 }))
  let ran = false
  const filter = createWorldbookFilter({ selection: () => ({}), beginTask: async () => ({ participantRequest: {}, bindSession() {}, participant: () => ({}), commit: async () => ({ status: 'committed' }), fail: async () => {} }),
    runAgent: async input => {
      ran = true
      const payload = JSON.parse(input.messages[0].content[0].text)
      assert.deepEqual(payload.candidates.map(item => item.ref), ['29'])
      assert.throws(() => input.onToolCall({ name: 'worldbook_candidate_read', arguments: { refs: ['0'] } }), /不在本轮/)
      input.onToolCall({ name: 'worldbook_filter_submit', arguments: { selected: ['29'] } })
      return { traceSessionId: 'background' }
    } })
  const result = await filter({ chat: { sessionId: 's', messages: [{ role: 'assistant', sourceText: '卯之花治疗伤口' }] }, userText: '交易', candidates })
  assert.equal(ran, true)
  assert.deepEqual(result.selected, ['29'])
  assert.equal(result.decisions[0].reason, 'BM25 粗筛排除')
  assert.equal(result.candidateCount, 30)
})

test('BM25 query includes the current player action alongside the latest story', async () => {
  const candidates = [
    { ref: 'healing', text: '药王谷 治疗 伤口', tokenCost: 4000 },
    { ref: 'schools', text: '少林 武当 拜师', tokenCost: 4000 },
    ...Array.from({ length: 21 }, (_, i) => ({ ref: 'other-' + i, text: '沙漠 商人 交易', tokenCost: 4000 }))
  ]
  let offered
  const filter = createWorldbookFilter({ selection: () => ({}),
    beginTask: async () => ({ participantRequest: {}, bindSession() {}, participant: () => ({}), commit: async () => ({ status: 'committed' }), fail: async () => {} }),
    runAgent: async input => {
      offered = JSON.parse(input.messages[0].content[0].text).candidates.map(item => item.ref)
      input.onToolCall({ name: 'worldbook_filter_submit', arguments: { selected: offered } })
      return { traceSessionId: 'background' }
    } })
  for (const body of [{ sourceText: '药王谷治疗伤口', text: '沙漠商人交易' }, { text: '药王谷治疗伤口' }]) {
    const result = await filter({ chat: { messages: [{ role: 'assistant', ...body }] }, userText: '少林武当拜师', candidates })
    assert.equal(result.bm25.ran, true)
    assert.deepEqual(offered, ['healing', 'schools'])
  }
  await filter({ chat: { messages: [] }, userText: '少林武当拜师', candidates })
  assert.deepEqual(offered, ['schools'])
  await filter({ chat: { messages: [{ role: 'assistant', text: '药王谷治疗伤口' }] }, candidates })
  assert.deepEqual(offered, ['healing'])
})
