import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../tavern-plugin/lib/index.js', import.meta.url), 'utf8')
const start = source.indexOf("      name: 'tavern_copy_card'")
const end = source.indexOf('\n    }))', start)
const definition = source.slice(start, end)
test('copy tool declares outputs, checks workbench access and returns image status', async () => {
  let mode = 'story', called = 0
  const tool = vm.runInNewContext('({' + definition + '})', {
    chatForSession: async () => ({ mode }),
    fileResources: { copyCard: async (path, name) => { called++; return { path: 'cards/' + name + '.json', sourcePath: path, imageCopied: true } } }
  })
  await assert.rejects(tool.execute({ path: 'cards/a.json', name: 'b' }, {}), /工作台/)
  assert.equal(called, 0)
  mode = 'card'
  const result = await tool.execute({ path: 'cards/a.json', name: 'b' }, {})
  assert.equal(result.imageCopied, true)
  assert.equal(result.path, 'cards/b.json')
  assert.equal(JSON.parse(tool.output.render({}, result)[0].text).imageCopied, true)
  assert.equal(tool.isConcurrencySafe(), false)
})
