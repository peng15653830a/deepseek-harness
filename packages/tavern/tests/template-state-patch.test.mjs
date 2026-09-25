import test from 'node:test'
import assert from 'node:assert/strict'
import {diffJson} from '../tavern-plugin/lib/domain/json-mutation.js'
import {applyTemplateStateChanges} from '../tavern-plugin/lib/domain/template-state-patch.js'

test('局部回执支持数组增删和字段移除，保留未变化历史引用且不修改基线',()=>{
  const before={chat:[{mes:'固定历史'},{mes:'回复',swipes:['一','二'],variables:[{hp:7},{hp:8}]}],metadata:{remove:true}}
  const saved=structuredClone(before)
  const after={chat:[before.chat[0],{mes:'回复',swipes:['一'],variables:[{hp:9}]}],metadata:{added:{ok:true}}}
  const result=applyTemplateStateChanges(before,diffJson(before,after))
  assert.deepEqual(result,after)
  assert.deepEqual(before,saved)
  assert.equal(result.chat[0],before.chat[0])
  const next={...after,chat:[...after.chat,{mes:'追加'}]}
  assert.deepEqual(applyTemplateStateChanges(result,diffJson(result,next)),next)
})
