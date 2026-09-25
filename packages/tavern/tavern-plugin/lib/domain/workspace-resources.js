import { prompt } from '../prompt-catalog.js'

function str(value) {
  return typeof value === 'string' ? value : (value === undefined || value === null ? '' : String(value))
}

export function resourceWorkspaceContext(value, projection, template = prompt('card-workspace')) {
  const root = str(value).trim()
  if (root === '') return ''
  const paths = projection && typeof projection === 'object' ? [
    '- 资源格式与操作说明：`' + str(projection.specPath) + '`。',
    '- 当前绑定快照：`' + str(projection.bindingsPath) + '`。',
    '- 当前 Session 上下文：`' + str(projection.contextPath) + '`。',
    '- 当前 Session 诊断摘要：`' + str(projection.diagnosticsPath) + '`。'
  ].join('\n') : ''
  const variables = { resourceRoot: JSON.stringify(root), projectionPaths: paths }
  return str(template).replace(/\{\{(resourceRoot|projectionPaths)\}\}/g, (_, key) => variables[key]).trim()
}

import { normalizeResourcePath, resourceKind } from './file-resources.js'

const RESOURCE_KINDS = Object.freeze(['card', 'preset', 'source', 'script', 'worldbook'])

function playChatReference(item) {
  const chatId = str(item && item.chatId).trim()
  const path = str(item && item.path).trim()
  const turn = Number(item && item.turn)
  if (!/^chat-[a-z0-9-]+$/i.test(chatId) || path !== 'play-chat:' + chatId || !Number.isInteger(turn) || turn < 1) return null
  return {
    kind: 'play-chat', path, label: str(item.label).trim() || ('游玩第 ' + turn + ' 轮'), chatId, turn,
    sourceUpdatedAt: Math.max(0, Number(item.sourceUpdatedAt) || 0),
    cardSnapshotVersion: Math.max(0, Number(item.cardSnapshotVersion) || 0),
    cardSnapshotDigest: str(item.cardSnapshotDigest).trim()
  }
}

export function mentionedTavernResources(text) {
  const resources = []
  const mentions = []
  const legacyPattern = /@\[([^\]\r\n]*)\]\(tavern-file:([^\s)]+)\)/g
  const worldBookPattern = /@\[([^\]\r\n]*)\]\(tavern-worldbook:([^\s)]+)\)/g
  const nativePattern = /@"([^"\r\n]+)"/g
  let match
  const input = str(text)
  while ((match = legacyPattern.exec(input)) !== null) {
    let decoded
    try { decoded = decodeURIComponent(match[2]) } catch { continue }
    mentions.push({ index: match.index, path: decoded, label: str(match[1]).trim() })
  }
  while ((match = worldBookPattern.exec(input)) !== null) {
    let decoded
    try { decoded = decodeURIComponent(match[2]) } catch { continue }
    mentions.push({ index: match.index, path: decoded, label: str(match[1]).trim(), kind: 'worldbook' })
  }
  while ((match = nativePattern.exec(input)) !== null) {
    mentions.push({ index: match.index, path: match[1], label: match[1].split('/').filter(Boolean).at(-1) || match[1] })
  }
  mentions.sort(function (a, b) { return a.index - b.index })
  for (const mention of mentions) {
    let path
    try { path = normalizeResourcePath(mention.path) } catch { continue }
    const resource = { kind: mention.kind || resourceKind(path), path, label: mention.label || path }
    if (resource.kind === 'worldbook' && resourceKind(path) !== 'worldbook' && resourceKind(path) !== 'card') continue
    if (!resources.some(function (item) { return item.kind === resource.kind && item.path === resource.path })) resources.push(resource)
  }
  return resources
}

export function rememberTavernResources(existing, text) {
  const resources = []
  for (const item of (Array.isArray(existing) ? existing : []).concat(mentionedTavernResources(text))) {
    if (item === null || typeof item !== 'object') continue
    const kind = str(item.kind)
    if (kind === 'play-chat') {
      const reference = playChatReference(item)
      if (reference !== null && !resources.some(function (entry) { return entry.kind === kind && entry.path === reference.path })) resources.push(reference)
      continue
    }
    let path
    try {
      path = kind === 'worldbook' ? normalizeResourcePath(item.path) : normalizeResourcePath(item.path, kind)
      if (kind === 'worldbook' && resourceKind(path) !== 'worldbook' && resourceKind(path) !== 'card') continue
    } catch { continue }
    if (!RESOURCE_KINDS.includes(kind)) continue
    const resource = { kind, path, label: str(item.label).trim() || path }
    const previous = resources.find(function (entry) { return entry.kind === kind && entry.path === path })
    if (previous === undefined) resources.push(resource)
    else if (resource.label !== path) previous.label = resource.label
  }
  return resources
}

export { RESOURCE_KINDS }
