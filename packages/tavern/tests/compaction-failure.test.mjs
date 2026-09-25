import test from 'node:test'
import assert from 'node:assert/strict'
import { compactionFailureMessage } from '../tavern-plugin/lib/domain/compaction-failure.js'
test('压缩外层通用错误保留内部超限分类，不暴露代理负载', () => {
  const inner = Object.assign(new Error('PRIVATE provider payload'), { code: 'CONTEXT_WINDOW_EXCEEDED' })
  const error = new Error('manual compaction could not produce a smaller summary', { cause: new Error('summary failed', { cause: inner }) })
  assert.match(compactionFailureMessage(error), /超出模型上下文窗口/)
  assert.match(compactionFailureMessage(error), /contextWindow/)
  assert.doesNotMatch(compactionFailureMessage(error), /PRIVATE/)
  const cyclic = new Error('普通失败'); cyclic.cause = cyclic
  assert.equal(compactionFailureMessage(cyclic), '普通失败')
})

test('流空闲超时显示时长、未完成状态和处理建议，保留安全技术信息', () => {
  const inner = new Error('pi-ai stream idle timeout after 300000ms PRIVATE payload')
  const error = new Error('manual compaction could not produce a smaller summary', { cause: inner })
  const message = compactionFailureMessage(error)
  assert.match(message, /连续 5 分钟未收到模型响应/)
  assert.match(message, /本次压缩未完成，原始聊天记录仍保留/)
  assert.match(message, /换模型发送一条消息后再压缩/)
  assert.match(message, /stream idle timeout after 300000ms/)
  assert.doesNotMatch(message, /PRIVATE/)
  assert.match(compactionFailureMessage('pi-ai stream idle timeout after 90000ms'), /90 秒/)
  assert.equal(error.cause, inner)
})

test('摘要变长或等长时明确说明保留记录，不建议立即重复压缩', () => {
  for (const count of [1612, 1931]) {
    const cause = new Error(`summary is not smaller than the shadowed content (${count} estimated framed tokens >= 1612)`)
    const message = compactionFailureMessage(new Error('Compaction could not produce a useful summary.', { cause }))
    assert.match(message, /摘要未缩短内容，已保留原始记录/)
    assert.match(message, /本次未节省上下文，无需立即重复压缩/)
  }
  assert.equal(compactionFailureMessage(new Error('manual compaction could not produce a smaller summary')), 'manual compaction could not produce a smaller summary')
})
