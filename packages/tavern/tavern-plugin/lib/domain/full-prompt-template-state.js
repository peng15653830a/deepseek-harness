import { isDeepStrictEqual } from 'node:util'
import { projectTavernHelperContext } from './tavern-helper-context.js'
import { assertPluginJson } from './tavern-chat-plugin-data.js'

const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key)
const fixedMessageFields = ['mes', 'is_user', 'is_system', 'name', 'swipe_id', 'swipes']
const templateFields = ['variables_initialized', 'is_ejs_processed']

/** Detached upstream-shaped state, not a second authoritative chat history. */
export function projectFullPromptTemplateState(chat) {
  const helper = projectTavernHelperContext(chat)
  return {
    chatId: chat.id, sessionId: chat.sessionId,
    stateRevision: helper.stateRevision, lifecycleRevision: helper.lifecycleRevision,
    chat: helper.messages.map(message => ({
      mes: message.message, is_user: message.role === 'user', is_system: message.role === 'system',
      name: message.name || '', swipe_id: message.swipe_id, swipes: structuredClone(message.swipes),
      variables: message.swipes_data.map(value => value && typeof value === 'object' && !Array.isArray(value) ? structuredClone(value) : {}),
      ...Object.fromEntries(templateFields.filter(key => own(message.pluginData, key)).map(key => [key, structuredClone(message.pluginData[key])]))
    })),
    chat_metadata: { ...structuredClone(helper.chatMetadata), variables: structuredClone(helper.chatVariables) }
  }
}

function conflict(message) {
  const error = new Error(message)
  error.code = 'PROMPT_TEMPLATE_STATE_CONFLICT'
  throw error
}
function merge(base, current, desired, label) {
  const next = structuredClone(current)
  for (const key of new Set([...Object.keys(base), ...Object.keys(desired)])) {
    const equals = (a,b) => own(a,key) === own(b,key) && isDeepStrictEqual(a[key],b[key])
    if (equals(base,desired)) continue
    if (!equals(base,current) && !equals(desired,current)) conflict(label + '已被其他操作修改，请重新读取')
    if (own(desired,key)) Object.defineProperty(next,key,{value:structuredClone(desired[key]),enumerable:true,writable:true,configurable:true})
    else delete next[key]
  }
  return next
}
function identity(row) { return Object.fromEntries(fixedMessageFields.map(key=>[key,row?.[key]])) }

export function validateFullPromptTemplateSave(request) {
  if (!request || typeof request.chatId !== 'string' || !request.chatId
    || !Number.isSafeInteger(request.stateRevision) || request.stateRevision < 1
    || !Number.isSafeInteger(request.lifecycleRevision) || request.lifecycleRevision < 0
    || !Array.isArray(request.chat)) throw new Error('模板存档缺少有效的读取版本')
  if (Object.keys(request).some(key=>!['chatId','sessionId','stateRevision','lifecycleRevision','chat','chat_metadata'].includes(key))) throw new Error('模板存档包含不支持的字段')
  assertPluginJson(request.chat_metadata, '模板聊天元数据')
  if (!request.chat_metadata.variables || Array.isArray(request.chat_metadata.variables) || typeof request.chat_metadata.variables !== 'object') throw new Error('模板聊天变量必须是对象')
  for (const row of request.chat) {
    assertPluginJson(row, '模板消息')
    if (Object.keys(row).some(key=>![...fixedMessageFields,'variables',...templateFields].includes(key))) throw new Error('模板消息包含不支持的字段')
    if (!Array.isArray(row.variables)) throw new Error('模板消息变量必须按 swipe 保存')
    row.variables.forEach(value=>assertPluginJson(value,'模板消息变量'))
  }
}

/** Merge only changed template state against an authoritative persisted baseline. */
export function applyFullPromptTemplateState(current, baseline, request) {
  validateFullPromptTemplateSave(request)
  if (!baseline || baseline.id !== request.chatId || baseline._storageRevision !== request.stateRevision
    || current.id !== request.chatId || current.sessionId !== baseline.sessionId
    || request.sessionId !== current.sessionId
    || (current.tavernHelperLifecycleRevision || 0) !== request.lifecycleRevision
    || (baseline.tavernHelperLifecycleRevision || 0) !== request.lifecycleRevision) conflict('模板读取版本已过期或聊天已切换')
  const base = projectFullPromptTemplateState(baseline), latest = projectFullPromptTemplateState(current)
  if (request.chat.length !== base.chat.length || latest.chat.length !== base.chat.length) conflict('聊天楼层已变化，模板存档未保存')
  const next = structuredClone(current)
  for (let index=0; index<base.chat.length; index++) {
    const before=base.chat[index], now=latest.chat[index], desired=request.chat[index]
    if (!isDeepStrictEqual(identity(before),identity(now))) conflict('聊天正文或 swipe 已变化，模板存档未保存')
    if (!isDeepStrictEqual(identity(before),identity(desired))) {
      const error=new Error('模板正文修改需要原生历史操作，不能通过变量存档提交')
      error.code='PROMPT_TEMPLATE_HISTORY_UNSUPPORTED'; throw error
    }
    const count=Math.max(before.variables.length,now.variables.length,1)
    if (desired.variables.length > Math.max(count,before.swipes.length)) conflict('模板变量指向不存在的 swipe')
    const variables=structuredClone(now.variables)
    for(let swipe=0;swipe<Math.max(before.variables.length,desired.variables.length);swipe++) {
      const b=before.variables[swipe] || {}, d=desired.variables[swipe] || {}, n=now.variables[swipe] || {}
      if (!isDeepStrictEqual(b,d)) variables[swipe]=merge(b,n,d,'消息变量')
    }
    if (!isDeepStrictEqual(variables,now.variables)) next.messages[index].variables=variables
    const fields = row=>Object.fromEntries(templateFields.filter(key=>own(row,key)).map(key=>[key,row[key]]))
    const merged=merge(fields(before),fields(now),fields(desired),'模板消息标记')
    if (!isDeepStrictEqual(merged,fields(now))) {
      const data={...next.messages[index].tavernPluginData}
      for(const key of templateFields) { if(own(merged,key)) data[key]=merged[key]; else delete data[key] }
      next.messages[index].tavernPluginData=data
    }
  }
  const withoutVariables = value => Object.fromEntries(Object.entries(value).filter(([key])=>key!=='variables'))
  const metadata=merge(withoutVariables(base.chat_metadata),withoutVariables(latest.chat_metadata),withoutVariables(request.chat_metadata),'模板聊天元数据')
  // Merge the variable namespace per key, preserving unrelated concurrent MVU writes.
  metadata.variables=merge(base.chat_metadata.variables,latest.chat_metadata.variables,request.chat_metadata.variables,'聊天变量')
  next.variables=metadata.variables; delete metadata.variables
  next.tavernPluginMetadata=metadata
  return next
}
