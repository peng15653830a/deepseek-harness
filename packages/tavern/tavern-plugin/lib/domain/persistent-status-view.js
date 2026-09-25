import { createHash } from 'node:crypto'
import { applyTavernRegexText } from './tavern-regex-display.js'
import { projectDisplayParts } from './reply-presentation.js'

function contentOf(part) {
  return String(part && (part.content ?? part.html) || '')
}

/** Only an explicit display declaration creates a persistent panel. MVU reads
 * are diagnostic evidence, never authority to move an interactive document. */
export function projectPersistentStatusView(messages, projections, options = {}) {
  const sourceMessages = Array.isArray(messages) ? messages : []
  const sourceProjections = Array.isArray(projections) ? projections : []
  let inferredTurn = 1
  let latestTurn = 1
  for (const message of sourceMessages) {
    if (message?.role === 'user') inferredTurn++
    if (message?.role === 'assistant') latestTurn = Math.max(latestTurn, Number(message.turn) || inferredTurn)
  }
  const templates = new Map()
  for (const rule of Array.isArray(options.regexScripts) ? options.regexScripts : []) {
    if (!rule || rule.disabled === true) continue
    const pattern = String(rule.findRegex || '')
    const namedStatus = pattern.match(/<([a-z][a-z0-9-]*-status)\b/i)
    const marker = pattern.includes('StatusPlaceHolderImpl') ? '<StatusPlaceHolderImpl/>' : namedStatus ? '<' + namedStatus[1] + '/>' : ''
    if (!marker) continue
    const rendered = applyTavernRegexText(marker, [rule],
      { placement: 2, isMarkdown: true, isEdit: false, depth: 0 })
    if (!rendered.changed) continue
    for (const part of projectDisplayParts(rendered.text).parts) {
      const content = contentOf(part)
      if (part.kind !== 'html' || !/<(?:script|iframe|object|embed)\b/i.test(content)) continue
      const revision = createHash('sha256').update(content).digest('hex').slice(0, 16)
      if (templates.has(revision)) continue
      let origin = null
      for (const projection of sourceProjections) {
        const parts = (projection.parts || []).filter(part => String(part.kind === 'html' ? contentOf(part) : part.text || '').trim())
        const index = parts.findIndex(part => part.kind === 'html' && contentOf(part) === content)
        if (index >= 0) origin = { sourceTurn: projection.turn, sourcePartIndex: index }
      }
      if (latestTurn <= 1 && !origin) continue
      templates.set(revision, {
        version: 1, viewId: 'status-' + revision,
        title: String(rule.name || rule.scriptName || '角色状态').slice(0, 80),
        sourceTurn: origin?.sourceTurn || latestTurn, sourcePartIndex: origin?.sourcePartIndex || 0,
        targetTurn: latestTurn, templateRevision: revision, content
      })
    }
  }
  const statusViews = [...templates.values()]
  const contents = new Set(statusViews.map(view => view.content))
  return {
    projections: sourceProjections.map(projection => {
      const parts = (projection.parts || []).filter(part => !(part.kind === 'html' && contents.has(contentOf(part))))
      return parts.length === (projection.parts || []).length ? projection : { ...projection, parts }
    }),
    statusView: statusViews[0] || null,
    statusViews
  }
}
