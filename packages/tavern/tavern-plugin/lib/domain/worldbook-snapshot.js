import { createHash } from 'node:crypto'
import { sessionEvents } from './session-events.js'

// Compare model-visible history, not prepared Chat state. Rewind/fork naturally
// select their own baseline; compaction of the record causes a full refresh.
export function worldbookSnapshot(session, text, pendingMessages = []) {
  text = String(text || '').trim()
  const events = new Map(sessionEvents(session).map(event => [event.seq, event]))
  const messages = (session?.surface?.nodes || []).map(seq => events.get(seq))
    .filter(event => event?.type === 'user/message').map(event => event.data).concat(pendingMessages)
  let previous
  for (const message of messages) {
    const record = message?.source?.worldbookSnapshot
    if (message?.source?.plugin !== 'dsh-tavern' || record?.schemaVersion !== 1) continue
    const content = (message.content || []).filter(block => block.type === 'text').map(block => block.text).join('')
    if (content.includes(record.rendered)) previous = record
  }
  if (previous ? previous.text === text : !text) return null
  const version = createHash('sha256').update(text).digest('hex').slice(0, 16)
  // One complete ordered snapshot keeps cross-entry XML wrappers intact.
  const rendered = `【动态世界书快照 · ${version}】\n以下是当前完整状态，替代此前所有动态世界书快照；未列出的旧内容已失效。\n${text || '当前无有效动态条目，此前动态世界书内容全部失效。'}`
  return { schemaVersion: 1, text, version, rendered }
}
