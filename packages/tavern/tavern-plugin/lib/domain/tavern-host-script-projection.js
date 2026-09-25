import { parse } from 'acorn'

const hostNames = new Set(['TavernHelper', 'SillyTavern'])
function property(node) {
  return node?.computed ? (node.property?.type === 'Literal' ? node.property.value : null) : node?.property?.name
}
function walk(node, visit) {
  if (!node || typeof node !== 'object') return
  visit(node)
  for (const [key, child] of Object.entries(node)) {
    if (key === 'start' || key === 'end') continue
    if (Array.isArray(child)) child.forEach(value => walk(value, visit))
    else if (child && typeof child === 'object') walk(child, visit)
  }
}
/** Compile only known host-object accesses; never expose the real outer Window. */
export function projectTavernHostScript(source) {
  let tree
  try { tree = parse(source, { ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true }) }
  catch { return source }
  // Conservatively preserve scripts that bind their own window/parent/top identifiers.
  let shadowed = false
  walk(tree, node => {
    const patterns = node.type === 'VariableDeclarator' ? [node.id]
      : /Function/.test(node.type || '') ? (node.params || []).concat(node.id || [])
      : node.type === 'ImportSpecifier' || node.type === 'ImportDefaultSpecifier' || node.type === 'ImportNamespaceSpecifier' ? [node.local]
      : node.type === 'CatchClause' ? [node.param] : []
    patterns.forEach(pattern => walk(pattern, value => {
      if (value.type === 'Identifier' && ['window', 'parent', 'top', 'globalThis'].includes(value.name)) shadowed = true
    }))
  })
  if (shadowed) return source
  const edits = []
  walk(tree, node => {
    if (node.type !== 'MemberExpression' || !hostNames.has(property(node))) return
    const owner = node.object
    const bare = owner?.type === 'Identifier' && ['parent', 'top'].includes(owner.name)
    const qualified = owner?.type === 'MemberExpression' && ['parent', 'top'].includes(property(owner)) &&
      owner.object?.type === 'Identifier' && ['window', 'globalThis'].includes(owner.object.name)
    if (bare || qualified) edits.push({ start: owner.start, end: owner.end })
  })
  for (const edit of edits.sort((a, b) => b.start - a.start)) source = source.slice(0, edit.start) + 'globalThis' + source.slice(edit.end)
  return source
}

export function projectTavernHostHtml(html) {
  return html.replace(/(<script\b[^>]*>)([\s\S]*?)(<\/script\s*>)/gi,
    (_match, opening, script, closing) => opening + projectTavernHostScript(script) + closing)
}
