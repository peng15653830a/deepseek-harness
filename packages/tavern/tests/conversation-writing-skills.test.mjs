import test from 'node:test'
import assert from 'node:assert/strict'
import { createTavernSkillProvider } from '../tavern-plugin/lib/domain/tavern-skill-provider.js'

test('本局关闭后目录与直接加载均不可用，其他游戏不受影响', async () => {
  const skill = { name: 'writing', path: '/skills/writing', agents: ['foreground'] }
  const disabled = new Map()
  const provider = createTavernSkillProvider({
    providers: [{ list: async () => [skill], get: async () => skill }],
    library: { read: async () => skill }, roleFor: async () => 'foreground',
    enabledFor: async (item, scope) => !(disabled.get(scope) || []).includes(item.name)
  })
  const first = (await provider.list({ scope: 'a' })).candidates[0]
  assert.ok(first)
  disabled.set('a', ['writing'])
  assert.equal((await provider.list({ scope: 'a' })).candidates.length, 0)
  assert.equal(await provider.get(first, { scope: 'a' }), undefined)
  assert.equal((await provider.list({ scope: 'b' })).candidates.length, 1)
  disabled.set('a', [])
  assert.ok(await provider.get(first, { scope: 'a' }))
})

test('全局与本局 Skill 面板分别保存，失败不改变开关显示', async () => {
  const { readFile } = await import('node:fs/promises')
  const vm = await import('node:vm')
  const source = await readFile(new URL('../tavern-plugin/src/client/main.js', import.meta.url), 'utf8')
  for (const globalDefaults of [true, false]) {
    let cursor = 0, fail = false
    const states = [], effects = [], calls = []
    const render = vm.runInNewContext('(' + source.slice(source.indexOf('function TavernConversationWritingSkills(props)'), source.indexOf('function TavernDefaultModelSetting(props)')).trim() + ')', {
      React: { useState(initial) { const i = cursor++; if (!(i in states)) states[i] = initial; return [states[i], value => { states[i] = value }] }, useEffect(fn) { effects.push(fn) }, createElement: (type, props, ...children) => ({ type, props, children }) },
      rpc: async (method, args) => { calls.push({ method, args }); if (fail) throw Error('保存失败'); return { skills: [{ name: 'writing', description: '写作', enabled: true }] } }
    })
    function tree() {
      cursor = 0; const nodes = []
      function visit(n) { if (Array.isArray(n)) return n.forEach(visit); if (!n || typeof n !== 'object') return; nodes.push(n); n.children?.forEach(visit) }
      visit(render({ globalDefaults, sessionId: globalDefaults ? undefined : 'game' })); return nodes
    }
    tree(); effects[0](); await new Promise(resolve => setImmediate(resolve))
    assert.equal(calls[0].method, globalDefaults ? 'getDefaultWritingSkills' : 'getConversationWritingSkills')
    const toggle = () => tree().find(n => n.props?.role === 'switch')
    await toggle().props.onChange({ target: { checked: false } })
    assert.equal(calls.at(-1).method, globalDefaults ? 'setDefaultWritingSkill' : 'setConversationWritingSkill')
    assert.equal(toggle().props.checked, false)
    fail = true
    await toggle().props.onChange({ target: { checked: true } })
    assert.equal(toggle().props.checked, false)
    assert.ok(tree().some(n => n.props?.role === 'alert'))
  }
})
