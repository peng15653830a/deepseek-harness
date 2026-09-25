import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { freezeMvuAppearance, renderFrozenAppearance } from '../tavern-plugin/lib/domain/mvu-conversion-appearance.js'
const appearance = {sourcePath:'/extensions/regex_scripts/0/replaceString',bindings:[{capture:1,path:'/位置'}]}
const freeze = html => freezeMvuAppearance({extensions:{regex_scripts:[{replaceString:html}]}},appearance)
test('复杂脚本、动态属性及漏映射明确拒绝，不删除原样式',()=>{
  for (const html of ['<div>$1<script>throw Error()</script></div>','<div onclick="go()">$1</div>','<div class="$1">位置</div>','<div>$1 $2</div>','<div>{{user}} $1</div>']) assert.throws(()=>freeze(html))
})
test('伪造内容指纹仍不能让验收执行原卡脚本',()=>{
  const frozen=freeze('<div>$1</div>')
  frozen.html+='<script>throw Error("UNTRUSTED")</script>'
  frozen.htmlDigest=createHash('sha256').update(frozen.html).digest('hex')
  assert.throws(()=>renderFrozenAppearance(frozen,p=>p.slice(1).split('/'),{位置:'门口'}),/自定义脚本/)
})
test('内容篡改、变量路径缺失均在渲染前拒绝',()=>{
  const frozen=freeze('<div>$1</div>')
  assert.throws(()=>renderFrozenAppearance({...frozen,html:'<div>改写</div>'},p=>p.slice(1).split('/'),{位置:'门口'}),/指纹/)
  assert.throws(()=>renderFrozenAppearance(frozen,p=>p.slice(1).split('/'),{}),/路径不存在/)
})
