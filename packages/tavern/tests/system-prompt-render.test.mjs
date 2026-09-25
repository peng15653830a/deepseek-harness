import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

for (const file of ['src/client/main.js', 'lib/client.js']) {
  test(`${file}: system prompt panel renders loading and loaded states without preset context`, () => {
    const source = readFileSync(new URL('../tavern-plugin/' + file, import.meta.url), 'utf8')
    const component = source.slice(source.indexOf('function SystemPromptSidebarTab()'), source.indexOf('function createResourcesLibraryFeatureModule()'))
    for (const loading of [true, false]) {
      const React = {
        createElement: (type, props, ...children) => ({ type, props, children }),
        useState: initial => [{ ...initial, loading, prompts: [{ name: 'system-append', label: 'system附加指令', text: '' }] }, () => {}],
        useRef: () => ({ current: null }), useEffect: () => {}
      }
      const render = new Function('React', 'useTavernConfirm', component + '; return SystemPromptSidebarTab;')(React, () => async () => false)
      const tree = render()
      assert.match(JSON.stringify(tree), /系统提示词/)
      if (!loading) {
        assert.match(JSON.stringify(tree), /system附加指令/)
        const switches = []
        function visit(node) {
          if (!node || typeof node !== 'object') return
          if (node.props?.role === 'switch') switches.push(node)
          for (const child of node.children || []) { if (Array.isArray(child)) child.forEach(visit); else visit(child) }
        }
        visit(tree)
        assert.equal(switches.length, 1)
        assert.equal(switches[0].type, 'button')
        assert.match(switches[0].props.className, /is-toggle/)
        assert.equal(switches[0].props['aria-checked'], false)
      }
      assert.doesNotMatch(JSON.stringify(tree), /应用到当前游戏/)
    }
  })
}
