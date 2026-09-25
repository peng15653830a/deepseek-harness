import test from 'node:test'
import assert from 'node:assert/strict'
import { rescueHistoryInput, assertRescueHistoryEditable } from '../tavern-plugin/lib/domain/chat-history-rescue.js'
import { conversationStateAtTurn } from '../tavern-plugin/lib/domain/conversation-fork-point.js'
test('rescue extracts only narrative text and rejects empty sources',()=>{
 const input=rescueHistoryInput({id:'old',cardPath:'card',messages:[{role:'system',text:'hidden'},{role:'assistant',text:'story',variables:[{secret:42}],swipes:['other']} ]})
 const rows=input.text.split('\n').map(JSON.parse)
 assert.equal(rows.length,2);assert.deepEqual(rows[1],{is_user:false,mes:'story'})
 assert.throws(()=>rescueHistoryInput({cardPath:'card',messages:[]}),/没有可迁移/)
})
test('new rounds remain editable, rescued historical forks are blocked',async()=>{
 const chat={messages:[{role:'assistant',text:'old',turn:1,importSource:{operationId:'op'}}],importHistory:{operationId:'op',rescue:{sourceChatId:'old'}}}
 assert.throws(()=>assertRescueHistoryEditable(chat),/不能回退/)
 await assert.rejects(conversationStateAtTurn(chat,1,()=>{throw Error('must not read revisions')}),/救援/)
 chat.messages.push({role:'user',text:'continue'},{role:'assistant',text:'new',turn:2})
 assert.doesNotThrow(()=>assertRescueHistoryEditable(chat))
})
test('MVU rescue refuses absent or invalid selected snapshots instead of silently resetting state',()=>{
 const source={id:'old',cardPath:'card',mvu:{enabled:true},messages:[{role:'assistant',text:'story',swipeId:1,variables:[{stat_data:{hp:5},schema:{}}]}]}
 assert.throws(()=>rescueHistoryInput(source),/没有.*可用 MVU 快照/)
 source.messages[0].variables.push({stat_data:{hp:6}})
 assert.throws(()=>rescueHistoryInput(source),/没有.*可用 MVU 快照/)
})
