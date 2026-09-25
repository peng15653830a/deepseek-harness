import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { chromium } from 'playwright'

const loader = await readFile(new URL('../tavern-plugin/src/client/modules/remote-document-loader.js', import.meta.url), 'utf8')
const jquery = await readFile(new URL('../tavern-plugin/lib/vendor/runtime-assets/jquery/jquery.min.js', import.meta.url), 'utf8')

test('body.load 整页保留脚本顺序、清除顶层缩进、保留正文换行及回调', async t => {
  const server = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    if (req.url === '/jquery.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(jquery); return }
    if (req.url === '/dependency.js' || req.url === '/api/dsh-tavern/dependency.js') { res.setHeader('Content-Type', 'text/javascript'); setTimeout(() => res.end('window.library=window.library||{};'), 100); return }
    if (req.url === '/remote') { res.setHeader('Content-Type', 'text/html'); res.end(`<!doctype html><html><head><base href="https://assets.invalid/"><link rel="stylesheet" href="/api/dsh-tavern/test.css">\n  <script src="http://${req.headers.host}/dependency.js"></script>\n  <script>library.config={color:'purple'};window.configApplied=true;</script>\n  <script src="/api/dsh-tavern/dependency.js"></script><script>window.proxiedDependency=!!window.library;</script><style>#root{height:100px}pre{white-space:pre-wrap}</style>\n</head><body>\n  <div id="root"><pre>第一行\n第二行</pre></div>\n</body></html>`); return }
    if (req.url === '/api/dsh-tavern/test.css') { res.setHeader('Content-Type', 'text/css'); res.end(''); return }
    if (req.url === '/fragment') { res.end('<p id="selected">片段</p><script>window.shouldNotExecute=true;</script>'); return }
    res.setHeader('Content-Type', 'text/html')
    res.end('<html><head><style>body{margin:0;white-space:pre-wrap}body>*{white-space:normal}</style><script src="/jquery.js"></script></head><body></body></html>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const origin = `http://127.0.0.1:${server.address().port}`
  const browser = await chromium.launch({ headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.goto(origin)
  if (!process.env.TAVERN_REMOTE_LOAD_BASELINE) await page.addScriptTag({ content: loader + ';installTavernRemoteDocumentLoader();' })
  await page.evaluate(url => { window.callbackDone = false; const body = $('body'); window.chainPreserved = body.load(url, function (_html, status) { window.callbackDone = true; window.callbackStatus = status; window.callbackConfig = !!window.library?.config; }) === body; }, origin.replace('127.0.0.1', 'localhost') + '/remote')
  await page.waitForFunction(() => window.callbackDone)
  const result = await page.evaluate(() => ({ configured: window.callbackConfig, status: window.callbackStatus, chain: window.chainPreserved, top: document.getElementById('root').getBoundingClientRect().top, text: document.querySelector('pre').textContent }))
  assert.equal(result.configured, true)
  assert.equal(await page.evaluate(() => window.proxiedDependency), true)
  assert.equal(result.status, 'success')
  assert.equal(result.chain, true)
  assert.equal(await page.locator('link').getAttribute('href'), origin + '/api/dsh-tavern/test.css')
  assert.equal(result.top, 0)
  assert.equal(result.text, '第一行\n第二行')
  await page.evaluate(url => new Promise(resolve => $('body').load(url + ' #selected', resolve)), origin + '/fragment')
  assert.equal(await page.locator('#selected').innerText(), '片段')
  assert.equal(await page.evaluate(() => window.shouldNotExecute), undefined)
})
