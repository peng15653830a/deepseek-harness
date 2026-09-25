import { sessionEvents } from './session-events.js'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { createDurableFilePromotion } from '../durable-file-promotion.js'

const EVENT = 'dsh-tavern/stable-prefix'
const pending = new WeakMap()
const MESSAGE_FORM = 'snapshot'
const LEGACY_MESSAGE_FORM = 'session-prefix'

function str(value) {
  return typeof value === 'string' ? value : (value === undefined || value === null ? '' : String(value))
}

export function createSessionStablePrefixStorage(directory) {
  const files = createDurableFilePromotion()
  function file(id) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('无效的固定背景 Session ID')
    return path.join(directory, id + '.json')
  }
  return {
    async read(id) {
      let value
      try { value = JSON.parse(await readFile(file(id), 'utf8')) } catch (error) {
        if (error.code === 'ENOENT') return null
        throw error
      }
      if (value?.version !== 1 || value.id !== 'tavern-session-prefix:' + id || typeof value.text !== 'string' || !value.text.trim()) throw new Error('固定背景文件格式无效：' + id)
      return value
    },
    async write(id, value) { await files.write(file(id), JSON.stringify(value) + '\n') }
  }
}

function messageRecord(event) {
  const message = event && event.type === 'user/message' ? event.data : null
  if (!str(message?.id).startsWith('tavern-session-prefix:') || message.role !== 'user' || message.source?.kind !== 'plugin' ||
      message.source?.plugin !== 'dsh-tavern' || ![MESSAGE_FORM, LEGACY_MESSAGE_FORM].includes(message.source?.form) || !Array.isArray(message.content)) return null
  const text = typeof message.source.fixedSystemText === 'string' ? message.source.fixedSystemText : message.content.filter(block => block?.type === 'text').map(block => str(block.text)).join('').trim()
  if (text === '') return null
  return { version: typeof message.source.fixedSystemText === 'string' ? 3 : 2, id: message.id, text, message, event }
}

function sourceSections(text) {
  const boundaries = [
    { marker: '【用户已确认的长期偏好】', name: 'tavern:user-preference' },
    { marker: '【故事设定 · 人物卡】', name: 'tavern:character-card' },
    { marker: '【常驻世界书】', name: 'tavern:constant-worldbook' }
  ]
  const starts = boundaries.map(function (boundary) {
    return { ...boundary, index: text.indexOf(boundary.marker) }
  }).filter(function (boundary) { return boundary.index >= 0 }).sort(function (left, right) { return left.index - right.index })
  if (starts.length === 0) return [{ name: 'tavern:session-context', text }]
  const sections = []
  if (starts[0].index > 0 && text.slice(0, starts[0].index).trim() !== '') {
    sections.push({ name: 'tavern:session-context', text: text.slice(0, starts[0].index).trim() })
  }
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index]
    const end = starts[index + 1]?.index ?? text.length
    sections.push({ name: start.name, text: text.slice(start.index, end).trim() })
  }
  return sections
}

/** Read the immutable snapshot from original events, even after its Surface node was compacted. */
export function readSessionStablePrefix(session) {
  if (!session) return null
  let legacy = null
  for (const event of sessionEvents(session)) {
    const record = messageRecord(event)
    if (!record) continue
    if (typeof record.message.source.fixedSystemText === 'string') return record
    legacy ||= record
  }
  return legacy
}

function legacyEventText(session) {
  const event = sessionEvents(session).find(item => item.type === EVENT && item.data?.version === 1 && item.data.id === 'tavern-session-prefix:' + session.id)
  return str(event && event.data && event.data.text).trim()
}

function fixedContextMessage(session, text) {
  return {
    id: 'tavern-session-prefix:' + session.id,
    role: 'user',
    content: [],
    source: {
      kind: 'plugin',
      plugin: 'dsh-tavern',
      form: MESSAGE_FORM,
      fixedSystemText: text,
      sections: sourceSections(text)
    }
  }
}

/** Persist fixed system text in native snapshot metadata; empty content cannot become summary material. */
export async function ensureSessionStablePrefix(session, text, storage) {
  const existing = readSessionStablePrefix(session)
  if (existing) {
    const activeLegacy = sessionEvents(session).find(event => messageRecord(event)?.message.content.length && session.surface?.nodes.includes(event.seq))
    const needsSnapshot = typeof existing.message.source.fixedSystemText !== 'string'
    if (needsSnapshot || activeLegacy) {
      // Old EJS prefixes used the saved play-card snapshot at the request boundary.
      // Freeze that same evaluated snapshot once when migrating, never reevaluate per turn.
      const context = needsSnapshot && /<%[\s\S]*?%>/.test(existing.text) && str(text).trim() ? str(text).trim() : existing.text
      const message = { ...fixedContextMessage(session, context), id: 'tavern-session-prefix:' + session.id + ':system-migration' }
      const event = session.append('user/message', message, activeLegacy ? {
        surfaceOp: { op: 'replace', start: activeLegacy.seq, end: activeLegacy.seq }, sourceEventSeqs: [activeLegacy.seq]
      } : { surfaceOp: 'append' })
      return messageRecord(event)
    }
    return existing
  }
  if (!session || typeof session.append !== 'function') throw new Error('无法写入 Session 固定背景')
  if (pending.has(session)) return pending.get(session)
  const operation = (async function () {
    const saved = storage ? await storage.read(session.id) : null
    const context = legacyEventText(session) || str(saved && saved.text).trim() || str(text).trim()
    if (context === '') return null
    const message = fixedContextMessage(session, context)
    const event = session.append('user/message', message, { surfaceOp: 'append' })
    return messageRecord(event)
  })()
  pending.set(session, operation)
  try { return await operation } finally { pending.delete(session) }
}

/** Native system assembly is the only model-visible owner of fixed background. */
export function sessionStablePrefixSections(session) {
  const prefix = readSessionStablePrefix(session)
  return prefix ? sourceSections(prefix.text) : []
}

/** Replace only the request projection; persisted opening events remain immutable. */
export function withCurrentWorldbook(sections, context) {
  const fixed = sections.filter(section => section.name !== 'tavern:constant-worldbook')
  const text = str(context).trim()
  return text ? [{ name: 'tavern:constant-worldbook', text: '【常驻世界书】\n' + text }, ...fixed] : fixed
}
