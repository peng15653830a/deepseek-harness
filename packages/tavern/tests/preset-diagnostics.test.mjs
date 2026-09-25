import test from 'node:test'
import assert from 'node:assert/strict'
import { createPresetDiagnostics } from '../tavern-plugin/lib/domain/preset-diagnostics.js'

test('诊断记录本局预设快照和正文正则管线顺序，保留完整匹配条件', () => {
  const global = {ref:'global:0',id:'g',enabled:false,findRegex:'/x/g',replaceString:'<div>x</div>'}
  const character = {ref:'regex:0',id:'c',enabled:true,placement:[2]}
  const preset = {id:'p',markdownOnly:true,minDepth:2,replaceString:'<script>render()</script>'}
  const chat = {id:'chat-test',runtimePresetSnapshot:{presetName:'本局旧版本',regexScripts:[preset],prompts:[{content:'本局提示词'}]}}
  const before = JSON.stringify(chat)
  const result = createPresetDiagnostics(chat, {regexScripts:[global,character],globalRegexScripts:[global],characterRegexScripts:[character]}, 123)
  assert.equal(result.preset.presetName,'本局旧版本')
  assert.deepEqual(result.regex.ordered.map(row=>row.source),['global','character','preset'])
  assert.deepEqual(result.regex.ordered.map(row=>row.order),[1,2,3])
  assert.deepEqual(result.regex.ordered[2].rule,preset)
  assert.equal(result.regex.ordered[0].rule.enabled,false)
  assert.equal(JSON.stringify(chat),before)
  assert.equal(createPresetDiagnostics({id:'empty'}).preset,null)
})
