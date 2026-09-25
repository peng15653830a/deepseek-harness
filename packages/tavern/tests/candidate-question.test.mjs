import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
const source = await readFile(new URL('../tavern-plugin/src/client/main.js', import.meta.url), 'utf8')
const code = source.slice(source.indexOf('function CandidateQuestion(props)'), source.indexOf('function CandidateGuidePanel(props)'))
function harness(initial = '', mode = 'after-send') {
  let draft = initial, cursor, running = false
  const states = [0, true], refs = [], effects = []
  let panel = { sessionId: 's', messageId: 'm', phase: 'ready', expanded: true, choices: [{ type: 'action', text: '走近窗边' }, { type: 'scene', text: '雨停了' }] }
  const React = { createElement: (type, props, ...children) => ({ type, props: props || {}, children }), useRef: () => refs[0] ||= {}, useState: () => { const i = cursor++; return [states[i], value => { states[i] = value }] }, useEffect: (fn, deps) => effects.push({ fn, deps }) }
  const Component = new Function('React', 'useCandidatePanel', 'useTavernSessionMode', 'latestTavernAssistantMessageId', 'isPlayMode', 'useCandidatePreferences', 'setCandidatePanel', code + ';return CandidateQuestion')(React, () => panel, () => 'story', () => 'm', () => true, () => mode, value => { panel = value })
  const props = { sessionId: 's', useInput: fn => fn({ draft }), useSession: fn => fn({ running }), useChat: () => 'm', inputActions: { setDraft: value => { draft = value } } }
  const render = () => { cursor = 0; effects.length = 0; return Component(props) }
  function buttons(node) { if (!node || typeof node !== 'object') return []; if (Array.isArray(node)) return node.flatMap(buttons); return [...(node.type === 'button' ? [node] : []), ...buttons(node.children)] }
  return { remount: () => { states[0] = -1; states[1] = false; render(); effects.forEach(effect => effect.fn()); }, render, buttons, draft: () => draft, panel: () => panel, states, effects, run: () => { running = true } }
}
test('连续添加人物行为和场景变化保留草稿及完整候选列表', () => {
  const h = harness('手动写的内容')
  const add = () => h.buttons(h.render()).find(node => node.children.includes('追加到输入框')).props.onClick()
  add()
  assert.equal(h.draft(), '手动写的内容\n走近窗边')
  assert.equal(h.states[0], -1)
  assert.equal(h.panel().expanded, true)
  assert.equal(h.buttons(h.render()).filter(node => node.props.className?.includes('question-option')).length, 2)
  h.states[0] = 1; add()
  assert.equal(h.draft(), '手动写的内容\n走近窗边\n【场景变化】雨停了')
})
test('空输入不加前导换行，已有换行不重复；发送中隐藏并收起', () => {
  for (const text of ['', '草稿\n']) {
    const h = harness(text)
    h.buttons(h.render()).find(node => node.children.includes('追加到输入框')).props.onClick()
    assert.equal(h.draft(), text + '走近窗边')
    h.run(); assert.equal(h.render(), null)
    h.effects.find(effect => effect.deps[0] === true).fn()
    assert.equal(h.panel().expanded, false)
  }
})

test('默认填入后隐藏，切换为发送后收起才保留列表', () => {
  for (const mode of ['after-fill', undefined, 'after-send']) {
    const h = harness('草稿', mode === undefined ? 'unknown' : mode)
    h.buttons(h.render()).find(node => node.children.includes('追加到输入框')).props.onClick()
    assert.equal(h.draft(), '草稿\n走近窗边')
    assert.equal(h.render() === null, mode !== 'after-send')
  }
})

test('保存设置立即通知已挂载的候选列表，旧读取结果不会覆盖新设置', async () => {
  const hook = source.slice(source.indexOf('function useCandidatePreferences()'), source.indexOf('function CandidatePreferencesSettings()'))
  const window = new EventTarget()
  let mode, effect, resolve
  const React = { useState: initial => { mode = initial; return [mode, value => { mode = value }] }, useEffect: fn => { effect = fn } }
  const usePreferences = new Function('React', 'window', 'rpc', hook + '; return useCandidatePreferences')(React, window, () => new Promise(done => { resolve = done }))
  usePreferences()
  const cleanup = effect()
  const event = new Event('dsh-tavern-candidate-preferences'); event.detail = 'after-send'
  window.dispatchEvent(event)
  assert.equal(mode, 'after-send')
  resolve({ candidateDismissMode: 'after-fill' }); await Promise.resolve()
  assert.equal(mode, 'after-send')
  cleanup()
  const late = new Event('dsh-tavern-candidate-preferences'); late.detail = 'after-fill'
  window.dispatchEvent(late)
  assert.equal(mode, 'after-send')
})

test('追加后输入区域重新挂载，仍保留展开的候选列表', () => {
  const h = harness('草稿')
  h.buttons(h.render()).find(node => node.children.includes('追加到输入框')).props.onClick()
  h.remount()
  assert.equal(h.buttons(h.render()).filter(node => node.props.className?.includes('question-option')).length, 2)
})

test('同一候选后台重新投影保留展开状态，新生成与跨会话不继承', () => {
  const store = source.slice(source.indexOf('const candidatePanel ='), source.indexOf('function useCandidatePanel()'))
  const api = new Function(store + '; return { set: setCandidatePanel, get: () => candidatePanel.value }')()
  const panel = { sessionId: 's', messageId: 'm', phase: 'ready', choices: ['甲', '乙'] }
  api.set({ ...panel, expanded: true })
  api.set({ ...panel, choices: ['甲', '乙'] })
  assert.equal(api.get().expanded, true)
  api.set({ ...panel, sessionId: 'other' })
  assert.equal(api.get().expanded, false)
  api.set({ ...panel, expanded: true })
  api.set({ ...panel, phase: 'loading', choices: [] })
  api.set(panel)
  assert.equal(api.get().expanded, false)
})
