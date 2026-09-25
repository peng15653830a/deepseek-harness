import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
const source = await readFile(new URL('../tavern-plugin/src/client/main.js', import.meta.url), 'utf8')
const code = source.slice(source.indexOf('async function expandTavernFrame('), source.indexOf('function TavernMessageFrame(props)'))
function harness() {
  const errors = []
  const expand = new Function('tavernErrorHub', code + ';return expandTavernFrame;')({ report: (...args) => errors.push(args) })
  return { expand, errors }
}
test('大屏使用已加载的可见 iframe，不创建或重新加载页面', async () => {
  const h = harness()
  let opened = 0
  const frame = { requestFullscreen: async () => { opened++ } }
  await h.expand({ querySelector: selector => {
    assert.equal(selector, 'iframe:not([aria-hidden="true"])')
    return frame
  } })
  assert.equal(opened, 1)
  assert.deepEqual(h.errors, [])
})
test('未加载时显示错误', async () => {
  const h = harness()
  await h.expand(null)
  assert.equal(h.errors.length, 1)
})

test('拒绝全屏时保留原 iframe 并提供可退出的大屏，移除面板时清理', async () => {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent('<button id="origin">展开</button><div id="root" style="transform:translateX(0);overflow:hidden;height:100px"><iframe style="height:80px" srcdoc="<p>live</p>"></iframe></div>')
    await page.locator('iframe').waitFor()
    await page.evaluate(code => {
      window.errors = []
      window.expand = new Function('tavernErrorHub', code + ';return expandTavernFrame;')({ report: (...args) => errors.push(args) })
      window.savedFrame = document.querySelector('iframe')
      window.savedWindow = savedFrame.contentWindow
      savedWindow.marker = 42
      savedFrame.requestFullscreen = async () => { throw Error('Disallowed by permissions policy') }
      document.querySelector('#origin').focus()
    }, code)
    await page.evaluate(() => expand(document.querySelector('#root')))
    assert.equal(await page.locator('iframe').evaluate(el => el.matches(':popover-open')), true)
    assert.equal(await page.locator('iframe').evaluate(el => el.getBoundingClientRect().height), 720)
    await page.getByRole('button', { name: '退出大屏' }).click()
    assert.deepEqual(await page.evaluate(() => [savedFrame.getAttribute('style'), savedFrame.contentWindow === savedWindow, savedFrame.contentWindow.marker, errors.length]), ['height:80px', true, 42, 0])
    await page.evaluate(() => expand(document.querySelector('#root')))
    await page.keyboard.press('Escape')
    assert.equal(await page.getByRole('button', { name: '退出大屏' }).count(), 0)
    await page.evaluate(async () => { savedFrame.requestFullscreen = undefined; await expand(document.querySelector('#root')); savedFrame.remove() })
    await page.getByRole('button', { name: '退出大屏' }).waitFor({ state: 'detached' })
  } finally { await browser.close() }
})

test('Android 工作台向嵌入页面授权全屏', async () => {
  const entry = await readFile(new URL('../android/dsh-tavern-entry/client.js', import.meta.url), 'utf8')
  assert.match(entry, /allow: "clipboard-read; clipboard-write; fullscreen", allowFullScreen: true/)
})
