import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
const source = await readFile(new URL('../tavern-plugin/lib/domain/scene-illustration.js', import.meta.url), 'utf8')
const code = source.slice(source.indexOf('function watchCancellation('), source.indexOf('async function failJob('))
test('取消轮询读取失败后继续，确认取消或失去归属才中止', async () => {
  let tick, value, failing = true, cleared = false
  const watch = new Function('deps', 'setInterval', 'clearInterval', 'console', code + ';return watchCancellation')({ store: { readJson: async () => { if (failing) throw Error('temporary'); return value } } }, fn => { tick = fn; return 1 }, () => { cleared = true }, { warn() {} })
  const record = { requestId: 'r', ownerId: 'o' }, controller = new AbortController()
  const stop = watch('job', record, controller)
  await tick(); assert.equal(controller.signal.aborted, false)
  failing = false; value = record
  await tick(); assert.equal(controller.signal.aborted, false)
  value = { ...record, cancelRequestedAt: 1 }
  await tick(); assert.equal(controller.signal.aborted, true)
  stop(); assert.equal(cleared, true)
  for (const next of [undefined, { requestId: 'different', ownerId: 'o' }, { requestId: 'r', ownerId: 'different' }]) {
    const controller = new AbortController(); value = next
    const stop = watch('job', record, controller)
    await tick(); assert.equal(controller.signal.aborted, true); stop()
  }
})
