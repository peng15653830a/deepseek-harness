import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'
const source = await readFile(new URL('../tavern-plugin/src/client/main.js', import.meta.url), 'utf8')

test('本局设置保存本局模型与开关，切换模型丢弃旧档位响应', async () => {
  const states = [], effects = [], calls = [], pending = []
  let failSave = false
  let cursor = 0
  let config = { modelCatalog: [], backgroundModel: null, sceneImagesAvailable: true, webSearchEnabled: false, sceneImagesEnabled: false, backgroundTasks: { variables: true, posture: true, characterDesign: false } }
  const render = vm.runInNewContext('(' + source.slice(source.indexOf('function TavernConversationBackgroundModel(props)'), source.indexOf('function TavernMoreActions(props)')).trim() + ')', {
    window: { dispatchEvent() {} }, CustomEvent: class {},
    React: { useState: initial => { const i = cursor++; if (!(i in states)) states[i] = initial; return [states[i], value => { states[i] = value }] }, useEffect: fn => effects.push(fn), createElement: (type, props, ...children) => ({ type, props, children }) },
    rpc: async (method, args, sessionId) => {
      calls.push({ method, args, sessionId })
      if (method === 'getConversationBackgroundConfig') return config
      if (method === 'getBackgroundModelReasoning') return new Promise(resolve => pending.push(resolve))
      if (failSave) throw new Error("模拟保存失败")
      config = { ...config, ...args, backgroundTasks: { ...config.backgroundTasks, ...args.backgroundTasks } }; return config
    }, liveTavernView: { invalidate() {} }, backgroundModelLabel: () => ''
  })
  function tree() {
    cursor = 0; effects.length = 0
    const nodes = []
    const visit = n => { if (Array.isArray(n)) return n.forEach(visit); if (!n || typeof n !== 'object') return; nodes.push(n); n.children?.forEach(visit) }
    visit(render({ sessionId: 'game-a' })); return nodes
  }
  tree(); effects[0](); await new Promise(resolve => setImmediate(resolve))
  const select = nodes => nodes.find(n => n.props?.['aria-label'] === '本局后台模型')
  await select(tree()).props.onChange({ target: { value: JSON.stringify({ provider: 'p', model: 'old' }) } })
  tree(); const cleanup = effects[1]()
  await select(tree()).props.onChange({ target: { value: JSON.stringify({ provider: 'p', model: 'new' }) } })
  cleanup(); tree(); effects[1]()
  pending[1]({ reasoning: { efforts: [{ id: 'new-level', name: 'New' }] } }); await new Promise(resolve => setImmediate(resolve))
  pending[0]({ reasoning: { efforts: [{ id: 'old-level' }] } }); await new Promise(resolve => setImmediate(resolve))
  let nodes = tree()
  const effort = nodes.find(n => n.props?.['aria-label'] === '本局后台推理强度')
  assert.match(JSON.stringify(effort), /new-level/); assert.doesNotMatch(JSON.stringify(effort), /old-level/)
  await effort.props.onChange({ target: { value: 'new-level' } })
  nodes = tree(); await nodes.find(n => n.props?.['aria-label'] === '变量结算').props.onChange({ target: { checked: false } })
  await tree().find(n => n.props?.['aria-label'] === '联网搜索').props.onChange({ target: { checked: true } })
  await tree().find(n => n.props?.['aria-label'] === '开启场景生图').props.onChange({ target: { checked: true } })
  assert.equal(tree().some(n => n.type === 'button' && n.children.includes('保存本局配置')), false)
  const call = calls.at(-1)
  assert.equal(call.method, 'setConversationBackgroundConfig'); assert.equal(call.sessionId, 'game-a')
  assert.equal(call.args.sessionId, 'game-a'); assert.equal(config.backgroundTasks.variables, false)
  assert.equal(call.args.backgroundModel.reasoningEffort, 'new-level')
  assert.equal(config.webSearchEnabled, true)
  assert.equal(call.args.sceneImagesEnabled, true)
  assert.equal(calls.some(c => c.method === 'updateTavernSettings'), false)
  failSave = true
  await tree().find(n => n.props?.['aria-label'] === '联网搜索').props.onChange({ target: { checked: false } })
  assert.equal(tree().find(n => n.props?.['aria-label'] === '联网搜索').props.checked, true)
  assert.ok(tree().some(n => n.props?.role === 'alert' && n.children.includes('模拟保存失败')))
  failSave = false
  await tree().find(n => n.props?.['aria-label'] === '联网搜索').props.onChange({ target: { checked: false } })
  assert.equal(tree().find(n => n.props?.['aria-label'] === '联网搜索').props.checked, false)

})

test('全局默认模型保存成功才更新选择，失败保留原配置', async () => {
  const states = [], effects = [], calls = []
  let cursor = 0, fail = false
  const render = vm.runInNewContext('(' + source.slice(source.indexOf('function TavernSettingsSection()'), source.indexOf('function UserPreferenceProfileTab(props)')).trim() + ')', {
    React: { useState(initial) { const i = cursor++; if (!(i in states)) states[i] = initial; return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value }] }, useEffect(fn) { effects.push(fn) }, createElement: (type, props, ...children) => ({ type, props, children }) },
    PromptTemplateSettingsEntry: 'templates', CandidatePreferencesSettings: 'candidates', TavernConversationWritingSkills: 'writing-skills', TavernDefaultModelSetting: 'model-setting', TavernTextColorSettings: 'text-color', ContextCompactionSettings: 'compaction', SceneImageSettings: 'images',
    rpc: async (method, args) => { calls.push({ method, args }); if (fail) throw Error('保存失败测试'); return { settings: { defaultForegroundModel: null, defaultBackgroundModel: null, ...args?.patch }, modelCatalog: [] } }
  })
  function tree() { cursor = 0; return render().children }
  tree(); await effects[0](); await new Promise(resolve => setImmediate(resolve))
  const control = label => tree().find(n => n?.props?.label === label)
  const choice = { provider: 'p', model: 'm', reasoningEffort: 'low' }
  await control('默认前台模型').props.onChange(choice)
  assert.deepEqual(control('默认前台模型').props.selection, choice)
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))), { method: 'updateTavernSettings', args: { patch: { defaultForegroundModel: choice } } })
  fail = true
  await control('默认前台模型').props.onChange(null)
  assert.deepEqual(control('默认前台模型').props.selection, choice)
  assert.ok(tree().some(n => n?.props?.role === 'alert'))
  fail = false
  await control('默认后台模型').props.onChange(choice)
  await control('默认前台模型').props.onChange(null)
  assert.equal(control('默认前台模型').props.selection, null)
  assert.deepEqual(control('默认后台模型').props.selection, choice)
})
