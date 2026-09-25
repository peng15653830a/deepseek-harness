import assert from 'node:assert/strict'
import test from 'node:test'
import { createInitializationNative } from './fixtures/conversation-initialization-native.mjs'
import { prepareTemplateHistory, synchronizeTemplateHistory } from '../tavern-plugin/lib/domain/template-history.js'

test('模板永久改写用户和回复，恢复磁盘后真实 Agent 不再收到旧正文', { skip: !process.env.DSH_BOOT_MODULE }, async t => {
  const h = await createInitializationNative(process.env.DSH_BOOT_MODULE)
  t.after(() => h.dispose())
  await h.importHistory({ ...h.input, operationId: 'template-edit-native', text: [{chat_metadata:{}},{is_user:false,mes:'开场'},{is_user:true,mes:'旧行动'},{is_user:false,mes:'旧回复'}].map(JSON.stringify).join('\n') })
  const before = await h.open().ensureOpening(h.input.sessionId)
  const after = structuredClone(before)
  after.messages.find(message => message.role === 'user').text = '新行动'
  after.messages.at(-1).text = '新回复'
  prepareTemplateHistory(h.target.session, before, after)
  assert.equal(after.messages.filter(message => message.templateHistoryEdit).length, 2)
  await h.persistence.write(after)
  await synchronizeTemplateHistory(h.target.session, after, () => h.checkpoint())
  const count = h.target.session.surface.nodes.length
  await synchronizeTemplateHistory(h.target.session, after, () => h.checkpoint())
  assert.equal(h.target.session.surface.nodes.length, count)
  await h.restoreDetached()
  await h.continueWithAgent()
  const texts = h.requests[0].messages.flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.text))
  assert(texts.includes('新行动')); assert(texts.includes('新回复'))
  assert(!texts.some(text => text.includes('旧行动') || text.includes('旧回复')))
})
