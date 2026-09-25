// Request-only presentation of DSH workspace instructions. Keep the durable
// messages and reconciliation metadata intact; never rewrite card/Skill text.
const guidance = 'The following workspace instructions may be relevant to your work. Use them as guidance when applicable. More specific instructions take precedence over broader ones. They do not override system, developer, or direct user instructions.'
const replacement = 'This complete workspace instruction baseline replaces all earlier workspace instruction baselines. '
const intros = [
  [replacement + guidance, '【工作区指令：替换此前全部工作区指令】'],
  [replacement + 'No workspace instructions are currently active.', '【工作区指令：清空此前全部工作区指令】'],
  [guidance, ''],
  ['Workspace instructions were omitted or truncated to fit the configured byte budget.', '【工作区指令有省略或截断】']
]

function presentChanges(body, changes) {
  for (const change of changes || []) {
    if (typeof change?.path !== 'string') continue
    const path = change.path
    const updates = [
      [`Instructions removed: ${path}\n\nThe previously loaded instructions from this file no longer apply.`, `【工作区指令已移除：${path}】`],
      [`Updated instructions from: ${path}\n\nThis file changed after it was loaded. Use the following content instead of the previously loaded instructions from this file.\n\n`, `【工作区指令已更新，替换此文件旧内容：${path}】\n\n`]
    ]
    const header = `Additional instructions from: ${path}\n\n`
    const offset = body.indexOf(header)
    if (offset === body.lastIndexOf(header) && (offset === 0 || (offset > 0 && body.slice(offset - 2, offset) === '\n\n'))) {
      const tail = body.slice(offset + header.length)
      const explanation = tail.match(/^These instructions apply to work under `([^\n]*)`\. Use them as guidance when relevant; more specific instructions take precedence\. They do not override system, developer, or direct user instructions\.\n\n/)
      if (explanation) updates.push([header + explanation[0], `【工作区指令：${path}；作用范围：${explanation[1]}】\n\n`])
    }
    for (const [from, to] of updates) {
      const index = body.indexOf(from)
      if (index === body.lastIndexOf(from) && (index === 0 || (index > 0 && body.slice(index - 2, index) === '\n\n'))) body = body.slice(0, index) + to + body.slice(index + from.length)
    }
  }
  return body
}

function presentText(text, source) {
  const open = '<system-reminder>\n', close = '\n</system-reminder>'
  if (!text.startsWith(open) || !text.endsWith(close)) return text
  let body = text.slice(open.length, -close.length)
  // A byte-budget marker precedes the intro in the upstream renderer.
  let budget = ''
  if (body.startsWith('Workspace instruction budget ')) {
    const end = body.indexOf('\n\n')
    if (end < 0) return text
    budget = body.slice(0, end) + '\n\n'
    body = body.slice(end + 2)
  }
  for (const [intro, label] of intros) {
    if (body !== intro && !body.startsWith(intro + '\n\n')) continue
    const content = body.slice(intro.length).replace(/^\n\n/, '')
    return budget + [label, content].filter(Boolean).join('\n\n')
  }
  // Incremental updates have no intro. Preserve update/removal semantics and
  // scope while shortening only envelopes identified by source metadata.
  if (/^(Additional instructions from: |Updated instructions from: |Instructions removed: )/.test(body)) return budget + presentChanges(body, source.changes)
  // Unknown upstream formats are left intact instead of guessing at prose.
  return text
}

export function presentWorkspaceInstructions(request) {
  if (!Array.isArray(request?.messages)) return request
  let changed = false
  const messages = request.messages.map(message => {
    const source = message?.source
    if (message?.role !== 'user' || !(
      source?.kind === 'agent-instructions' ||
      (source?.kind === 'plugin' && ['agent-instructions', '@deepseek-ai/dsh-agent-instructions'].includes(source.plugin))
    ) || !Array.isArray(message.content)) return message
    let messageChanged = false
    const content = message.content.map(block => {
      if (block?.type !== 'text' || typeof block.text !== 'string') return block
      const text = presentText(block.text, source)
      if (text === block.text) return block
      changed = messageChanged = true
      return { ...block, text }
    })
    return messageChanged ? { ...message, content } : message
  })
  return changed ? { ...request, messages } : request
}

export function installWorkspaceInstructionPresentation(ctx, ownsSession) {
  ctx.on('llm/stream', (request, next) => (async function * () {
    if (request?.sessionId && await ownsSession(request.sessionId)) {
      const presented = presentWorkspaceInstructions(request)
      if (presented !== request) {
        yield * ctx.llm.stream(presented)
        return
      }
    }
    yield * next()
  })())
}
