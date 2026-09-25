import assert from 'node:assert/strict'
import test from 'node:test'

import { filterSkillMessages } from '../tavern-plugin/lib/domain/skill-visibility.js'

const ordinary = { id: 'ordinary', source: { kind: 'plugin' } }
const catalog = { id: 'catalog', source: { kind: 'skill-catalog' } }
const invocation = { id: 'invocation', source: { kind: 'skill-invocation' } }

test('卡片模式保留 DSH Skill 目录和用户显式调用', () => {
  const messages = [ordinary, catalog, invocation]
  assert.equal(filterSkillMessages(messages, 'card'), messages)
})

test('游玩模式保留按 Agent 分配的原生 Skill 消息', () => {
  assert.deepEqual(filterSkillMessages([ordinary, catalog, invocation], 'story'), [ordinary, catalog, invocation])
  assert.deepEqual(filterSkillMessages([ordinary, catalog, invocation], 'script'), [ordinary, catalog, invocation])
})
