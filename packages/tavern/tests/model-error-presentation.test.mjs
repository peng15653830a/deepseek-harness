import assert from 'node:assert/strict'
import test from 'node:test'
import { presentModelError } from '../tavern-plugin/lib/domain/model-error-presentation.js'

test('空消息验证错误只显示原因，不带回传请求与密钥', () => {
  const original = new Error('400: ' + JSON.stringify({ message: 'messages: Validation error: message content cannot be empty [{"value": "PRIVATE_STORY sk-secret"}]' }))
  const result = presentModelError(original)
  assert.match(result.message, /400.*消息内容不能为空/)
  assert.doesNotMatch(JSON.stringify(result) + result.stack, /PRIVATE_STORY|sk-secret/)
  assert.equal(result.cause, undefined)
  assert.match(original.message, /PRIVATE_STORY/)
})
test('其他验证错误不展开输入对象，普通短错误保留', () => {
  const result = presentModelError(new Error('422: ' + JSON.stringify({ message: 'Validation error: invalid messages [{"value":"PRIVATE"}]' })))
  assert.ok(result.message.length < 200)
  assert.doesNotMatch(result.message, /PRIVATE/)
  const normal = new Error('Connection reset')
  assert.equal(presentModelError(normal), normal)
})
