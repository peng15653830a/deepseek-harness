import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createFullPromptTemplateAssetReader, FULL_PROMPT_TEMPLATE_ASSET_PREFIX as prefix } from '../tavern-plugin/lib/domain/full-prompt-template-assets.js'

test('模板静态服务仅提供清单内且校验通过的文件',async()=>{
  let body=Buffer.from('export const ready = true;')
  const manifest={upstreamCommit:'d6f520d149aba146305b0b781ddd691d449c28d2',files:{'index.js':{bytes:body.length,sha256:createHash('sha256').update(body).digest('hex')}}}
  const read=createFullPromptTemplateAssetReader({read:async url=>url.pathname.endsWith('manifest.json')?JSON.stringify(manifest):body})
  const asset=await read(prefix+'index.js')
  assert.match(asset.mediaType,/javascript/)
  assert.equal(await read(prefix+'missing.js'),undefined)
  assert.equal(await read(prefix+'../index.js'),undefined)
  body=Buffer.from('changed')
  await assert.rejects(read(prefix+'index.js'),/校验失败/)
})
