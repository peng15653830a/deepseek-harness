const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false })
const string = maxLength => ({ type: 'string', maxLength })
const fields = ['appearance', 'clothing', 'action', 'expression', 'position']
const sceneFields = ['environment', 'composition']
const visual = object({ text: string(600), tags: string(1200) }, ['text', 'tags'])
const propertiesFor = (names, schema) => Object.fromEntries(names.map(name => [name, schema]))
export const SCENE_CHARACTER_TOOL = {
  name: 'submit_scene_character', description: '向当前画面草稿提交一个人物。按 id 合并变化字段；不会保存正式人物方案或生成图片。',
  parameters: object({ id: string(100), name: string(100), fields: object(propertiesFor(fields, visual)),
    expressions: object(propertiesFor(fields, string(1200))) }, ['id', 'fields'])
}
export const SCENE_LAYOUT_TOOL = {
  name: 'submit_scene_layout', description: '保存当前画面草稿的场景、构图和人物顺序。不会生成图片。',
  parameters: object({ description: string(1000), subjects: { type: 'array', items: string(100), maxItems: 8 },
    continuity: { type: 'string', enum: ['continued', 'changed', 'uncertain'] },
    scene: object(propertiesFor(sceneFields, visual)), expressions: object(propertiesFor(sceneFields, string(1200)))
  }, ['description', 'subjects', 'continuity', 'scene'])
}
export const SCENE_PLAN_TOOL = {
  name: 'submit_scene_plan', description: '无参数确认当前草稿。校验后请求一张图片并等待保存，返回成功或具体失败结果。服务失败不会自动重发。不要重复携带 plan 或人物描述。',
  parameters: object({})
}
export const SCENE_DRAFT_TOOLS = [SCENE_CHARACTER_TOOL, SCENE_LAYOUT_TOOL, SCENE_PLAN_TOOL]
// Initial failure plus three corrections; successful draft calls do not consume this budget.
export const SCENE_PLAN_MAX_FAILURES = 4
const typeOf = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
const cjk = /[\u3400-\u9fff]/
/** Prose profiles require Chinese natural-language tags; keyword lists are rejected before an image request. */
export function proseTagProblem(profile, tags) {
  if (typeof profile !== 'string' || !profile.startsWith('scene-prose-v1:') || !tags.trim()) return ''
  return cjk.test(tags) ? '' : '当前工作流要求中文自然语言 tags，不能只写英文标签'
}
function invalid(path, message) { throw new Error('参数内容错误：' + path + ' ' + message) }
/** Weak local models emit nested objects as bare prose or JSON strings; coerce the common shapes before validation. */
const coerceVisual = value => {
  if (typeof value === 'string' && hasParameterMarkers(value)) {
    const blocks = parseParameterBlocks(value)
    value = typeof blocks.text === 'string' ? blocks.text : Object.values(blocks).find(v => typeof v === 'string' && v.trim()) ?? ''
  }
  if (typeof value === 'string') return { text: value, tags: value }
  if (typeOf(value) !== 'object') return value
  const text = typeof value.text === 'string' ? value.text : ''
  const tags = typeof value.tags === 'string' ? value.tags : (value.tags === undefined && text !== '' ? text : value.tags)
  return { text, tags }
}
const coerceObjectArg = value => {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (trimmed.startsWith('{')) {
    try { const parsed = JSON.parse(trimmed); if (typeOf(parsed) === 'object') return parsed } catch { /* stuttered braces below */ }
    return salvageStutteredObject(trimmed)
  }
  return null
}
/** 手写嵌套 JSON 常多打紧挨的闭合大括号（口吃，如 {"a":1}},"b":2}}），整体解析必然失败；
 *  只删字符串外的相邻多余 } 逐层重试，结构天然保持。实例来自真实日志：scene 整段原文被兜底
 *  塞进 environment.text，报"超过 600 字符"，模型压缩三次也无效，烧光修正额度。 */
function salvageStutteredObject(trimmed, budget = 2) {
  try { const parsed = JSON.parse(trimmed); if (typeOf(parsed) === 'object') return parsed } catch { /* 口吃括号，逐层删除重试 */ }
  if (budget <= 0) return null
  for (const candidate of adjacentCloseDeletions(trimmed)) {
    const salvaged = salvageStutteredObject(candidate, budget - 1)
    if (salvaged) return salvaged
  }
  return null
}
function adjacentCloseDeletions(text) {
  const candidates = []
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index++) {
    const ch = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
    } else if (ch === '"') inString = true
    else if (ch === '}' && text[index + 1] === '}') candidates.push(text.slice(0, index) + text.slice(index + 1))
  }
  return candidates
}
/** Nemotron 模板的工具调用是 <parameter=key>value 树；OpenRouter 只拆一层，嵌套标记留在值里。
 *  按 schema 引导解析：对象的子标记递归归位，字符串标记解出 text，未知键保留（交由拍平归位）或交还上层。 */
const hasParameterMarkers = value => typeof value === 'string' && value.includes('<parameter=')
function parseParameterBlocks(raw) {
  const blocks = {}
  const matches = [...raw.matchAll(/<parameter=([^>]+)>/g)]
  for (let index = 0; index < matches.length; index++) {
    const key = matches[index][1].trim()
    const start = matches[index].index + matches[index][0].length
    const end = index + 1 < matches.length ? matches[index + 1].index : raw.length
    blocks[key] = raw.slice(start, end).replace(/^\n/, '').replace(/\n$/, '')
  }
  return blocks
}
function parseGuidedMarkers(raw, schema, keepUnknown) {
  const out = {}
  const marker = /<parameter=([^>]+)>/g
  marker.lastIndex = 0
  let match
  while ((match = marker.exec(raw)) !== null) {
    const key = match[1].trim()
    const valueStart = match.index + match[0].length
    const prop = schema.properties?.[key]
    if (prop === undefined) {
      if (!keepUnknown) return { value: out, lastIndex: match.index }
      const next = raw.indexOf('<parameter=', valueStart)
      const end = next === -1 ? raw.length : next
      out[key] = raw.slice(valueStart, end).replace(/^\n/, '').replace(/\n$/, '')
      marker.lastIndex = end
      continue
    }
    if (prop.type === 'object') {
      const inner = raw.slice(valueStart).replace(/^\n/, '').replace(/\n$/, '')
      out[key] = hasParameterMarkers(inner) ? parseGuidedMarkers(inner, prop, false).value : inner
      break
    }
    const next = raw.indexOf('<parameter=', valueStart)
    const end = next === -1 ? raw.length : next
    let leaf = raw.slice(valueStart, end).replace(/^\n/, '').replace(/\n$/, '')
    if (hasParameterMarkers(leaf)) {
      const blocks = parseParameterBlocks(leaf)
      if (typeof blocks.text === 'string') leaf = blocks.text
    }
    if (prop.type === 'array') leaf = leaf.split(/[,，、]/).map(item => item.trim()).filter(Boolean)
    out[key] = leaf
    marker.lastIndex = end
  }
  return { value: out, lastIndex: marker.lastIndex }
}
function rebuildParameterTree(args, schema) {
  if (typeOf(args) !== 'object' || schema.type !== 'object') return args
  const out = {}
  for (const [key, raw] of Object.entries(args)) {
    const prop = schema.properties[key]
    if (prop === undefined || typeof raw !== 'string' || !hasParameterMarkers(raw)) { out[key] = raw; continue }
    if (prop.type === 'object') {
      out[key] = parseGuidedMarkers(raw, prop, false).value
    } else if (prop.type === 'string') {
      const blocks = parseParameterBlocks(raw)
      out[key] = typeof blocks.text === 'string' ? blocks.text : raw
    } else if (prop.type === 'array') {
      out[key] = raw.split(/[,，、]/).map(item => item.trim()).filter(Boolean)
    } else {
      out[key] = raw
    }
  }
  return out
}
function validate(value, schema, path) {
  const actual = typeOf(value)
  if (actual !== schema.type) invalid(path, '应为 ' + schema.type + '，实际为 ' + actual)
  if (schema.enum && !schema.enum.includes(value)) invalid(path, '须为 ' + schema.enum.join(' / '))
  if (schema.type === 'string' && value.length > schema.maxLength) invalid(path, '超过 ' + schema.maxLength + ' 字符（实际 ' + value.length + '）')
  if (schema.type === 'array') {
    if (value.length > schema.maxItems) invalid(path, '最多 ' + schema.maxItems + ' 项')
    value.forEach((item, index) => validate(item, schema.items, path + '[' + index + ']'))
  }
  if (schema.type === 'object') {
    // 本地模型常携带模式外字段（如 expression）；剥离即可，声明的字段仍严格校验。
    for (const key of Object.keys(value)) if (!Object.hasOwn(schema.properties, key)) delete value[key]
    for (const key of schema.required) if (!Object.hasOwn(value, key)) invalid(path + '.' + key, '缺失')
    for (const [key, item] of Object.entries(value)) validate(item, schema.properties[key], path + '.' + key)
  }
}

/** Preserve only the matching current call's raw JSON, before host fallback hides its syntax error. */
export function imageToolCall(name, args, execution, events = [], start = 0) {
  const call = { name, arguments: args }
  if (!execution?.callId) return call
  for (let index = events.length - 1; index >= start; index--) {
    const event = events[index]
    if (event.type === 'tool/call' && event.data?.callId === execution.callId && event.data.name === name) {
      if (typeof event.data.arguments === 'string') call.rawArguments = event.data.arguments
      break
    }
  }
  return call
}

export function readImageToolArguments(call) {
  let args = call.rawArguments ?? call.arguments
  if (typeof args === 'string') {
    const raw = args
    try { args = JSON.parse(raw) } catch (error) {
      const position = Number(error.message.match(/position (\d+)/)?.[1] ?? raw.length)
      const before = raw.slice(0, position)
      const line = before.split('\n').length
      const column = position - before.lastIndexOf('\n')
      const expected = /Expected ',' or ']'/.test(error.message) ? '此处预期 , 或 ]'
        : /Expected ',' or '}'/.test(error.message) ? '此处预期 , 或 }'
          : /property name|double-quoted property/.test(error.message) ? '对象字段名须用双引号'
            : /end of JSON/.test(error.message) ? '参数提前结束，请检查未闭合括号或引号' : '请检查此处的引号、逗号和括号'
      const near = raw.slice(Math.max(0, position - 24), position + 24)
      throw new Error('JSON 语法错误：第 ' + line + ' 行第 ' + column + ' 列（位置 ' + position + '），遇到 ' +
        (position < raw.length ? JSON.stringify(raw[position]) : '文本末尾') + '；' + expected + '。附近：' + JSON.stringify(near) + '。未解析成功，不是方案字段缺失；不要改字段名来修复语法。')
    }
  }
  if (typeOf(args) !== 'object') invalid('arguments', '应为 object，实际为 ' + typeOf(args))
  return args
}

/** Pure draft changes. The caller persists each accepted change in its existing image job. */
export function updateSceneDraft(draft, name, args, profile) {
  const tool = SCENE_DRAFT_TOOLS.find(tool => tool.name === name)
  if (!tool) invalid('tool', '未知工具 ' + name)
  // Nemotron 模板的工具调用是 <parameter=key>value 树；OpenRouter 只拆一层，嵌套标记留在值里。
  // 先重建嵌套结构，再把模板拍平到顶层的外观字段归位到 fields。
  if (Object.values(args).some(hasParameterMarkers)) args = rebuildParameterTree(args, tool.parameters)
  if (name === SCENE_CHARACTER_TOOL.name) {
    const strayVisuals = fields.filter(key => key !== 'fields' && args[key] !== undefined)
    if (strayVisuals.length) {
      args.fields = { ...(typeOf(args.fields) === 'object' ? args.fields : {}), ...Object.fromEntries(strayVisuals.map(key => [key, args[key]])) }
      for (const key of strayVisuals) delete args[key]
    }
    if (typeof args.fields === 'string') {
      const parsed = coerceObjectArg(args.fields)
      args.fields = typeOf(parsed) === 'object' ? parsed : { appearance: coerceVisual(args.fields) }
    }
    if (typeOf(args.fields) === 'object') for (const [key, item] of Object.entries(args.fields)) args.fields[key] = coerceVisual(item)
    if (typeof args.expressions === 'string') {
      const parsed = coerceObjectArg(args.expressions)
      if (typeOf(parsed) === 'object') args.expressions = parsed; else delete args.expressions
    }
  } else if (name === SCENE_LAYOUT_TOOL.name) {
    if (typeof args.scene === 'string') {
      const parsed = coerceObjectArg(args.scene)
      args.scene = typeOf(parsed) === 'object' ? parsed : { environment: coerceVisual(args.scene) }
    }
    if (typeof args.subjects === 'string') args.subjects = args.subjects.split(/[,，、]/).map(item => item.trim()).filter(Boolean)
    if (typeOf(args.scene) === 'object') for (const [key, item] of Object.entries(args.scene)) args.scene[key] = coerceVisual(item)
    if (typeof args.expressions === 'string') {
      const parsed = coerceObjectArg(args.expressions)
      if (typeOf(parsed) === 'object') args.expressions = parsed; else delete args.expressions
    }
  }
  validate(args, tool.parameters, name)
  const next = structuredClone({ characters: {}, layout: null, ...draft })
  if (name === SCENE_CHARACTER_TOOL.name) {
    if (!args.id.trim()) invalid(name + '.id', '不能为空')
    const previous = Object.hasOwn(next.characters, args.id) ? next.characters[args.id] : undefined
    if (!previous && Object.keys(next.characters).length >= 8) invalid('characters', '最多 8 人')
    for (const [field, value] of Object.entries(args.fields)) {
      if (Boolean(value.text.trim()) !== Boolean(value.tags.trim())) invalid(name + '.fields.' + field, 'text 和 tags 须同时为空或非空')
      const problem = proseTagProblem(profile, value.tags)
      if (problem) invalid(name + '.fields.' + field + '.tags', problem)
    }
    for (const [field, tags] of Object.entries(args.expressions || {})) {
      const problem = proseTagProblem(profile, tags)
      if (problem) invalid(name + '.expressions.' + field, problem)
    }
    next.characters = { ...next.characters, [args.id]: { ...previous, ...args,
      fields: { ...previous?.fields, ...args.fields }, expressions: { ...previous?.expressions, ...args.expressions } } }
  } else if (name === SCENE_LAYOUT_TOOL.name) {
    if (new Set(args.subjects).size !== args.subjects.length) invalid(name + '.subjects', '人物 id 不得重复')
    for (const [field, value] of Object.entries(args.scene)) {
      if (Boolean(value.text.trim()) !== Boolean(value.tags.trim())) invalid(name + '.scene.' + field, 'text 和 tags 须同时为空或非空')
      const problem = proseTagProblem(profile, value.tags)
      if (problem) invalid(name + '.scene.' + field + '.tags', problem)
    }
    for (const [field, tags] of Object.entries(args.expressions || {})) {
      const problem = proseTagProblem(profile, tags)
      if (problem) invalid(name + '.expressions.' + field, problem)
    }
    next.layout = structuredClone(args)
  }
  return next
}

export function assembleSceneDraft(draft) {
  if (!draft.layout) invalid('scene', '缺少场景草稿，请调用 submit_scene_layout')
  const { expressions: sceneExpressions = {}, ...layout } = draft.layout
  const characters = Object.values(draft.characters || {}).map(({ expressions, ...person }) => person)
  const expressions = Object.values(draft.characters || {}).flatMap(person => Object.entries(person.expressions || {}).map(([field, tags]) => ({ owner: person.id, field, tags })))
  expressions.push(...Object.entries(sceneExpressions).map(([field, tags]) => ({ owner: 'scene', field, tags })))
  return { ...structuredClone(layout), characters, expressions }
}

export function sceneDraftSummary(draft) {
  return { characters: Object.values(draft.characters || {}).map(person => ({ id: person.id, name: person.name, savedFields: Object.keys(person.fields) })),
    layoutSaved: Boolean(draft.layout), instruction: '已保存部分无需重发；可按 id 修改。完成后调用 submit_scene_plan({})。' }
}
