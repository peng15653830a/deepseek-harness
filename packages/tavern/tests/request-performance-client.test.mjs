import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import {readFile} from 'node:fs/promises'

test('真实 RPC 包装关联请求、导出浏览器时间点并兼容非安全上下文', async () => {
  const source = await readFile(new URL('../tavern-plugin/src/client/main.js', import.meta.url), 'utf8')
  const start = source.indexOf('\t\tfunction rpc(method,')
  const end = source.indexOf('\n\t\tfunction recordImageInteraction', start)
  const code = source.slice(start, end)
  const sent = [], rows = []
  const scope = vm.createContext({
    window: {}, performance, Date, Math,
    performanceReportAt: 0, pagePerformanceStarted: 0, pagePerformance: {}, performanceRequests: rows, performanceActiveRequests: 0,
    beginSessionViewRead: () => null, tavernRuntimeGenerationMonitor: {observe() {}},
    readTavernJsonResponse: response => response.json(),
    fetch: async (_url, request) => { sent.push(JSON.parse(request.body)); return {json: async () => ({ok:true})} }
  })
  vm.runInContext(code, scope)
  await scope.rpc('getSession', {}, 'session')
  assert.match(sent[0]._traceId, /^[a-f0-9-]{36}$/)
  assert.equal(rows[0].id, sent[0]._traceId)
  assert.equal(rows[0].active, 1)
  assert.ok(rows[0].parsedMs >= rows[0].headersMs)
  assert.equal(scope.performanceActiveRequests, 0)
  await scope.rpc('exportDiagnostics', {}, 'session')
  assert.equal(sent[1]._performance.requests[0].id, rows[0].id)
  scope.fetch = async () => { throw Error('offline') }
  await assert.rejects(scope.rpc('syncSession', {}, 'session'))
  assert.equal(rows.at(-1).failed, true)
  assert.equal(scope.performanceActiveRequests, 0)
})

test('HTTP RPC 拒因保留结构化错误码，兼容旧服务端的纯文本错误', async () => {
  const source = await readFile(new URL('../tavern-plugin/src/client/main.js', import.meta.url), 'utf8')
  const start = source.indexOf('\t\tfunction rpc(method,')
  let response = { ok: false, error: '事件不匹配', errorCode: 'MVU_SETTLEMENT_EVENT_MISMATCH' }
  const scope = vm.createContext({ window: {}, performance, Date,
    performanceReportAt: Date.now(), pagePerformanceStarted: Date.now(), pagePerformance: {},
    beginSessionViewRead: () => null, tavernRuntimeGenerationMonitor: { observe() {} },
    readTavernJsonResponse: res => res.json(), fetch: async () => ({ json: async () => response }) })
  vm.runInContext(source.slice(start, source.indexOf('\n\t\tfunction recordImageInteraction', start)), scope)
  await assert.rejects(scope.rpc('updateTavernHelperVariables', {}, 's'), error => error.message === '事件不匹配' && error.code === 'MVU_SETTLEMENT_EVENT_MISMATCH')
  response = { ok: false, error: '旧服务端错误' }
  await assert.rejects(scope.rpc('updateTavernHelperVariables', {}, 's'), error => error.message === '旧服务端错误' && error.code === undefined)
})
