import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import vm from 'node:vm'
import test from 'node:test'

test('原生命令声明自由输入并将参数原样交给所属模板实例', async () => {
  const source=await readFile(new URL('../tavern-plugin/lib/index.js',import.meta.url),'utf8')
  const registrations=[],calls=[]
  const ctx={get:()=>({register:definition=>{registrations.push(definition);return ()=>{}}}),effect:factory=>{[...factory()]}}
  const fullTemplateRuntime={forSession:id=>({command:async text=>{calls.push({id,text});return {pipe:'7'}}})}
  vm.runInNewContext(source.slice(source.indexOf("  const commands = ctx.get('commands')"),source.indexOf('  const sourceRoot =')), {ctx,fullTemplateRuntime})
  const command=registrations.find(c=>c.name==='ejs')
  // DSH's composer only claims commands with arguments when input is declared.
  assert.ok(command.input?.hint)
  const result=await command.handler({agent:{session:{id:'game'}},rawInput:'block=true _.keyBy([{id:"a",value:7}],"id").a.value'})
  assert.equal(result.kind,'success');assert.equal(result.text,'7')
  assert.deepEqual(calls,[{id:'game',text:'/ejs block=true _.keyBy([{id:"a",value:7}],"id").a.value'}])
})
