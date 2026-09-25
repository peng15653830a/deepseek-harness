import { replaceSessionSurface } from './session-surface-mutations.js'
import { createHash, randomUUID } from 'node:crypto'
import { editableReplyParts } from './reply-presentation.js'
import { locateRegenerationSurface } from './rollback-surface.js'
import { sessionEvents, appendSessionEvent } from './session-events.js'

function latest(chat) {
  const message = chat.messages?.at(-1)
  if (!['story', 'script'].includes(chat.mode || 'story') || message?.role !== 'assistant' || message.greeting) throw new Error('只能编辑最后一轮正文')
  return message
}
function source(message) { return message.projectionText ?? message.sourceText ?? message.text ?? '' }
function token(chat, message) {
  const { displayRuntime: _capture, ...body } = message
  return createHash('sha256').update(JSON.stringify([chat.id, chat.timeline?.branchId, chat.timeline?.revision, chat.messages.length, body])).digest('hex')
}

/** Reconcile a durable Chat edit to native Surface; retries never duplicate history. */
export async function synchronizeBodyEdits(session, chat, flush) {
  const recorded = new Set(sessionEvents(session).filter(event => event.type === 'assistant/message').map(event => event.data?.message?.id))
  for (const message of chat.messages || []) {
    if (!message.bodyEdit) continue
    const { id, seq, turn } = message.bodyEdit
    if (recorded.has(id)) continue
    if (!session.surface?.nodes.includes(seq)) throw new Error('编辑正文尚未同步，原消息已不在上下文中')
    replaceSessionSurface(session, 'assistant/message', {
      turn, step: 1,
      message: { id, role: 'assistant', content: [{ type: 'text', text: message.text }], source: { kind: 'model', provider: 'dsh-tavern', model: 'body-edit' } }
    }, { start: seq, end: seq, sourceEventSeqs: [seq] })
  }
  if ((chat.messages || []).some(message => message.bodyEdit)) await flush(session)
}

/** Edit prose only; do not replay macros, scripts or settlement. */
export function createBodyEditor({ chats, sessions, timeline, activity, project, present, sessionPatch }) {
  const pending = new Set()
  function refuseClosedPatch() {
    if (sessionPatch && !sessionPatch.replacementAllowed()) throw new Error(sessionPatch.blockReason())
  }
  function idle(chat, agent) {
    if (agent?.phase?.kind === 'running' || chat.regenInProgress || ['pending', 'running'].includes(chat.settleStatus) || activity(chat)?.busy) throw new Error('请等待当前生成或后台处理完成后再编辑')
  }
  async function context(sessionId) {
    refuseClosedPatch()
    const chat = await chats.forSession(sessionId)
    if (!chat) throw new Error('会话不存在')
    const agent = sessions.get(sessionId)
    if (!agent?.session) throw new Error('无法访问原生会话')
    idle(chat, agent)
    await synchronizeBodyEdits(agent.session, chat, sessions.flush)
    const message = latest(chat)
    const target = locateRegenerationSurface({ events: sessionEvents(agent.session), nodes: agent.session.surface?.nodes, turn: message.turn })
    if (!target) throw new Error('最后一轮正文已不在当前上下文中，无法编辑')
    const parts = editableReplyParts(source(message))
    if (!parts.some(part => part.kind === 'text' && part.text.trim())) throw new Error('这轮只有 HTML，没有可编辑文本')
    return { chat, agent, message, target, parts }
  }
  async function read(sessionId) {
    const { chat, message, parts } = await context(sessionId)
    return { token: token(chat, message), turn: message.turn, parts: parts.map(part => part.kind === 'text' ? part : { kind: part.kind }) }
  }
  async function save(sessionId, input) {
    if (pending.has(sessionId)) throw new Error('正在保存正文，请稍候')
    pending.add(sessionId)
    try {
      const { chat, agent, message, target, parts } = await context(sessionId)
      if (input?.token !== token(chat, message)) throw new Error('正文或会话已变化，请重新打开编辑')
      const texts = input.texts
      if (!Array.isArray(texts) || texts.length !== parts.filter(part => part.kind === 'text').length || texts.some(text => typeof text !== 'string')) throw new Error('编辑文本格式无效')
      if (!texts.some(text => text.trim())) throw new Error('正文不能为空')
      if (texts.some(text => editableReplyParts(text).some(part => part.kind !== 'text'))) throw new Error('这里只能编辑文本，不能新增 HTML')
      let index = 0
      const text = parts.map(part => part.kind === 'text' ? texts[index++] : part.text).join('')
      if (text === source(message)) return present(chat)
      const reply = await project(text, chat)
      const patch = {
        sourceText: text, projectionText: text, text: reply.sessionText,
        displayText: reply.displayText, displayMode: reply.displayMode,
        bodyEdit: { id: 'tavern-body-edit:' + randomUUID(), seq: target.assistantSeq, turn: target.turn }
      }
      if (Array.isArray(message.swipes)) {
        patch.swipes = structuredClone(message.swipes)
        const swipe = Number(message.swipeId) || 0
        if (typeof patch.swipes[swipe] === 'string') patch.swipes[swipe] = text
      }
      // Validate on an isolated native Session before the durable Chat intent.
      // A rejected host event must never publish an edit that future requests
      // will keep trying (and failing) to synchronize. Accepted writes retain
      // the existing journal-first recovery path for disk/flush failures.
      const preview = agent.session.constructor.fromRestore(agent.session.id, structuredClone(sessionEvents(agent.session)), structuredClone(agent.session.header), agent.session.inheritedEventCount, 'detached')
      await synchronizeBodyEdits(preview, { messages: [{ ...message, ...patch }] }, async () => {})
      const saved = await chats.update(chat.id, current => {
        idle(current, agent)
        if (token(current, latest(current)) !== input.token) throw new Error('正文或会话已变化，请重新打开编辑')
        if (!agent.session.surface?.nodes.includes(target.assistantSeq)) throw new Error('模型上下文已变化，请重新打开编辑')
        return timeline.apply({ chat: current, intent: { kind: 'body.edit', turn: message.turn, patch } }).chat
      }, { source: 'foreground.body-edit' })
      await synchronizeBodyEdits(agent.session, saved, sessions.flush)
      return present(saved)
    } finally { pending.delete(sessionId) }
  }
  return Object.freeze({ read, save })
}
