import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import path from 'node:path'
import { chromium } from 'playwright'
const source = await readFile(new URL('../tavern-plugin/src/client/modules/history-viewport.js', import.meta.url), 'utf8')
const make = new Function(source + ';return createTavernHistoryViewport')()
test('initial history is limited to 20, explicit loads append 20 and preserve loaded rounds', () => {
  const budget = make(), released = []
  const stops = []
  for (let turn = 1; turn <= 133; turn++) {
    stops.push(budget.register('a', turn, () => released.push(turn)))
    assert.ok(budget.snapshot().size <= 20)
  }
  assert.equal(budget.snapshot().size, 20)
  assert.ok(budget.snapshot().has(budget.key('a', 114)))
  budget.more('a')
  assert.equal(budget.snapshot().size, 40)
  assert.ok(budget.snapshot().has(budget.key('a', 94)))
  budget.more('a')
  assert.equal(budget.snapshot().size, 60)
  budget.register('a', 134, () => {})
  assert.equal(budget.snapshot().size, 61)
  assert.ok(budget.snapshot().has(budget.key('a', 74)))
  const stopDuplicate = budget.register('a', 74, () => {})
  stops[73]()
  assert.ok(budget.snapshot().has(budget.key('a', 74)))
  stopDuplicate()
  assert.equal(budget.snapshot().has(budget.key('a', 74)), false)
  for (let i = 0; i < 10; i++) budget.more('a')
  assert.equal(budget.snapshot().size, 133)
})

const dsh = process.env.DSH_BROWSER_ROOT || path.join(homedir(), '.dsh-tavern/runtime/lib/node_modules/@deepseek-ai/dsh')
test('real React keeps 20 rounds while scrolling and appends history only after manual clicks', { skip: !existsSync(dsh) && 'Set DSH_BROWSER_ROOT for the browser integration test' }, async () => {
  const require = createRequire(new URL('../package.json', import.meta.url))
  const names = ['react', 'scheduler', 'react-dom', 'react-dom/client']
  const files = ['react.production.js', 'scheduler.production.js', 'react-dom.production.js', 'react-dom-client.production.js']
  let bundle = 'const modules={};\n'
  for (let i = 0; i < names.length; i++) {
    const text = await readFile(path.join(path.dirname(require.resolve(names[i])), 'cjs', files[i]), 'utf8')
    bundle += `modules[${JSON.stringify(names[i])}]=(function(){const module={exports:{}},exports=module.exports,require=name=>modules[name];\n${text}\nreturn module.exports;})();\n`
  }
  const retained = await readFile(new URL('../tavern-plugin/src/client/modules/retained-message-frames.js', import.meta.url), 'utf8')
  const retention = await readFile(new URL('../tavern-plugin/src/client/modules/session-resource-retention.js', import.meta.url), 'utf8')
  const browser = await chromium.launch({headless:true})
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    const errors = []; page.on('pageerror', e => errors.push(e.message))
    await page.setContent('<div id="app"></div>')
    await page.addScriptTag({content: bundle + `
      const React=modules.react;
      ${retention}\n${retained}\n${source}
      const retention=createTavernSessionRetention({window});retention.select('a');
      const tavernRetainedFrames=createRetainedTavernFrames({window,retention,createLifecycle(props){
        const d={token:Math.random().toString(),trustedCardMode:true,html:'<input value="fresh"><script>window.identity=Math.random()</'+'script>',ref(){}};
        return {snapshot(){return {height:160,visibleDocument:d}},start(){return ()=>{}},update(){}};
      }});
      function Body(props){const ref=React.useRef(null);React.useLayoutEffect(()=>{
        const lease=tavernRetainedFrames.mount({sessionId:'a',turn:props.node.location.turn.turn,partIndex:0,frameOwner:props.frameOwner},ref.current);
        return ()=>lease.detach();
      },[]);return React.createElement('div',{ref,style:{height:160}});}
      const root=modules['react-dom/client'].createRoot(document.querySelector('#app'));
      root.render(React.createElement(React.Fragment,null,Array.from({length:133},(_,i)=>React.createElement(TavernWindowedNode,{key:i,sessionId:'a',node:{location:{turn:{turn:i+1}}},bodyComponent:Body}))));
      window.budget=tavernHistoryViewport;
      window.maxFrames=0;new MutationObserver(()=>{maxFrames=Math.max(maxFrames,document.querySelectorAll('iframe').length)}).observe(document.body,{subtree:true,childList:true});
    `})
    await page.waitForFunction(() => document.querySelectorAll('iframe').length === 20)
    assert.equal(await page.locator('iframe').count(), 20)
    await page.evaluate(() => { window.saved = document.querySelector('[data-tavern-history-turn="133"] iframe'); saved.contentDocument.querySelector('input').value = 'kept' })
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.waitForTimeout(200)
    assert.equal(await page.locator('iframe').count(), 20, 'scrolling alone must not expand history')
    await page.getByRole('button', {name:'加载更多（20 轮）', exact:true}).click()
    await page.waitForFunction(() => document.querySelectorAll('iframe').length === 40)
    await page.getByRole('button', {name:'加载更多（20 轮）', exact:true}).click()
    await page.waitForFunction(() => document.querySelectorAll('iframe').length === 60)
    assert.equal(await page.evaluate(() => saved === document.querySelector('[data-tavern-history-turn="133"] iframe') && saved.contentDocument.querySelector('input').value === 'kept'), true)
    for (let i = 0; i < 4; i++) await page.getByRole('button', {name:'加载更多（20 轮）', exact:true}).click()
    await page.waitForFunction(() => document.querySelectorAll('iframe').length === 133)
    assert.equal(await page.getByRole('button', {name:'加载更多（20 轮）', exact:true}).count(), 0)
    assert.deepEqual(errors, [])
  } finally { await browser.close() }
})
