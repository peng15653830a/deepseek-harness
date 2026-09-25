import { parseExpressionAt } from 'acorn'
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)

// Static validation only: never execute card scripts or rewrite the document.
export function validateCardText(text) {
  const errors = [], warnings = []
  const issue = (path, message) => errors.push({ path, message })
  const result = () => ({ valid: errors.length === 0, errors, warnings })
  let raw
  try { raw = JSON.parse(text) } catch (error) {
    // V8 messages contain document excerpts. Return location only.
    const position = /position (\d+)/.exec(error.message)
    const line = /line (\d+) column (\d+)/.exec(error.message)
    let location = ''
    if (position) {
      const prefix = text.slice(0, Number(position[1]))
      location = '（第 ' + prefix.split('\n').length + ' 行，第 ' + (prefix.length - prefix.lastIndexOf('\n')) + ' 列）'
    } else if (line) location = '（第 ' + line[1] + ' 行，第 ' + line[2] + ' 列）'
    if (!location) {
      try { parseExpressionAt(text, 0, { ecmaVersion: 2020, locations: true }) } catch (syntax) {
        if (syntax.loc) location = '（第 ' + syntax.loc.line + ' 行，第 ' + (syntax.loc.column + 1) + ' 列）'
      }
    }
    issue('/', 'JSON 语法错误' + location)
    return result()
  }
  let prefix = ''
  if (object(raw) && raw.kind === 'dsh-tavern-character-workspace') {
    if (raw.version !== 1) issue('/version', '不支持的人物卡工作版版本')
    raw = raw.raw; prefix = '/raw'
  }
  if (!object(raw)) { issue(prefix || '/', '人物卡根节点必须是对象'); return result() }
  let data = raw
  if (raw.spec !== undefined) {
    if (!['chara_card_v2', 'chara_card_v3'].includes(raw.spec)) issue(prefix + '/spec', '不支持的人物卡 spec')
    prefix += '/data'; data = raw.data
  }
  if (!object(data)) { issue(prefix, '人物卡 data 必须是对象'); return result() }
  if (typeof data.name !== 'string' || !data.name.trim()) issue(prefix + '/name', '角色名必须是非空字符串')
  for (const key of ['description', 'personality', 'scenario', 'first_mes', 'mes_example', 'system_prompt', 'post_history_instructions', 'creator_notes', 'creator', 'character_version']) {
    if (data[key] !== undefined && typeof data[key] !== 'string') issue(prefix + '/' + key, '必须是字符串')
  }
  for (const key of ['tags', 'alternate_greetings', 'group_only_greetings']) {
    if (data[key] !== undefined && (!Array.isArray(data[key]) || data[key].some(item => typeof item !== 'string'))) issue(prefix + '/' + key, '必须是字符串数组')
  }
  for (const key of ['extensions', 'character_book']) {
    if (data[key] !== undefined && data[key] !== null && !object(data[key])) issue(prefix + '/' + key, '必须是对象')
  }
  const extensions = object(data.extensions) ? data.extensions : {}
  const helper = extensions.tavern_helper
  if (helper !== undefined && !object(helper)) issue(prefix + '/extensions/tavern_helper', '必须是对象')
  if (object(helper)) {
    if (helper.variables !== undefined && !object(helper.variables)) issue(prefix + '/extensions/tavern_helper/variables', '变量初值必须是对象')
    if (helper.scripts !== undefined && !Array.isArray(helper.scripts)) issue(prefix + '/extensions/tavern_helper/scripts', '脚本集合必须是数组')
  }
  if (data.character_book && data.character_book.entries !== undefined && !Array.isArray(data.character_book.entries)) issue(prefix + '/character_book/entries', '世界书条目必须是数组')
  if (!data.first_mes) warnings.push({ path: prefix + '/first_mes', message: '未设置开场白；请确认是否符合预期' })
  warnings.push({ path: '/', message: '仅检查静态格式；未执行正则、脚本或 MVU 结算，格式通过不代表运行成功' })
  return result()
}

export async function validateCardFile({ path, readText }) {
  if (!path) return { valid: false, errors: [{ path: '/', message: '请先保存人物卡文件，再指定 cards/... 路径校验' }], warnings: [] }
  const text = await readText(path)
  if (text === undefined) return { valid: false, errors: [{ path, message: '人物卡文件不存在' }], warnings: [] }
  return validateCardText(text)
}
