import test from 'node:test'
import assert from 'node:assert/strict'
import { channelSettings, imageChannelRequest } from '../tavern-plugin/lib/domain/scene-image-channels.js'
import { comfyWorkflow, compileComfyWorkflow } from '../tavern-plugin/lib/domain/scene-image-comfy-workflow.js'
import { comfyGraph, comfyLinkedSeedGraph } from './fixtures/scene-image-comfy-workflow.mjs'
import { createImageConfiguration } from '../tavern-plugin/packages/dsh-image-gen/src/configuration.js'

const config = (provider, extras = {}) => ({ ...channelSettings({}, provider), baseURL: 'http://127.0.0.1:9999', apiKey: 'fixture', prompt: 'a quiet garden', ...extras })
test('NovelAI V3 and V4+ send controls in the native negative fields and preserve defaults', () => {
  for (const model of ['nai-diffusion-3', 'nai-diffusion-4-5-full', 'nai-diffusion-5-full']) {
    const original = imageChannelRequest(config('novelai', { model })).body.parameters
    assert.equal(original.steps, 23)
    assert.equal(original.negative_prompt, '')
    const body = imageChannelRequest(config('novelai', { model, steps: '28', guidance: '6.5', negativePrompt: 'watermark, blur' })).body
    assert.equal(body.parameters.steps, 28)
    assert.equal(body.parameters.scale, 6.5)
    assert.equal(body.parameters.negative_prompt, 'watermark, blur')
    if (model !== 'nai-diffusion-3') assert.equal(body.parameters.v4_negative_prompt.caption.base_caption, 'watermark, blur')
    assert.equal(body.input, 'a quiet garden')
  }
})
test('WebUI sends numeric controls; Qwen sends only native negative; unsupported channels omit them', () => {
  const controls = { negativePrompt: 'blur', steps: '30', guidance: '0' }
  const body = imageChannelRequest(config('webui', controls)).body
  assert.equal(body.steps, 30)
  assert.equal(body.cfg_scale, 0)
  assert.equal(body.negative_prompt, 'blur')
  const old = imageChannelRequest(config('webui')).body
  assert.equal(old.steps, undefined)
  assert.equal(old.negative_prompt, undefined)
  const qwen = imageChannelRequest(config('qwen', controls)).body
  assert.equal(qwen.parameters.negative_prompt, 'blur')
  assert.equal(qwen.parameters.steps, undefined)
  for (const provider of ['openai', 'gemini', 'grok', 'seedream', 'banana']) {
    const request = imageChannelRequest(config(provider, { ...controls, model: provider === 'banana' ? 'fixture' : channelSettings({}, provider).model }))
    assert.doesNotMatch(JSON.stringify(request.body), /negative_prompt|cfg_scale|"steps":30/)
  }
})
test('invalid controls fail before dispatch rather than being silently clamped', () => {
  for (const [provider, patch] of [['novelai', { steps: '51' }], ['webui', { steps: '0' }], ['webui', { steps: '1.5' }], ['webui', { guidance: 'NaN' }], ['novelai', { guidance: '11' }], ['webui', { steps: '1e2' }], ['qwen', { negativePrompt: 'x'.repeat(4001) }]]) {
    assert.throws(() => channelSettings(patch, provider))
  }
})
test('ComfyUI only changes mapped controls, keeps the source and defaults, rejects missing bindings', () => {
  const graph = comfyGraph(), before = structuredClone(graph)
  const workflow = comfyWorkflow(graph)
  const defaults = compileComfyWorkflow(workflow, 'new scene')
  assert.equal(defaults.prompt['4'].inputs.text, 'negative stays')
  assert.equal(defaults.prompt['5'].inputs.steps, 20)
  const settings = channelSettings({ workflow, negativePrompt: 'blur', steps: '32', guidance: '4.5' }, 'comfyui')
  const compiled = compileComfyWorkflow(settings.workflow, 'new scene', settings)
  assert.equal(compiled.prompt['4'].inputs.text, 'blur')
  assert.equal(compiled.prompt['5'].inputs.steps, 32)
  assert.equal(compiled.prompt['5'].inputs.cfg, 4.5)
  assert.equal(compiled.generationParameters.guidance[0].value, 4.5)
  assert.deepEqual(graph, before)
  assert.throws(() => channelSettings({ workflow: comfyLinkedSeedGraph(), negativePrompt: 'blur' }, 'comfyui'), /映射/)
  assert.ok(channelSettings({ workflow: comfyLinkedSeedGraph(), steps: '32' }, 'comfyui'))
})
test('saved controls survive module recreation and channel switches; stale capture never sends a paid request', async () => {
  let saved = {}, calls = []
  const make = () => createImageConfiguration({ read: async () => saved, write: async patch => { saved = { ...saved, ...patch } }, credentials: { resolve: async () => ({ value: 'fixture' }) },
    generateImpl: async input => { calls.push(imageChannelRequest(input).body); return { data: Buffer.from('fixture') } } })
  let service = make()
  await service.configure(config('webui', { steps: '31', guidance: '5.5', negativePrompt: 'blur' }))
  await service.configure(config('qwen', { negativePrompt: 'watermark' }))
  service = make()
  assert.equal((await service.inspect('webui')).steps, '31')
  assert.equal((await service.inspect('qwen')).negativePrompt, 'watermark')
  const { active, apiKey } = await service.capture('webui')
  await service.generate({ ...active, apiKey, prompt: 'first' })
  assert.equal(calls[0].steps, 31)
  await service.configure({ ...active, steps: '35' })
  await assert.rejects(service.generate({ ...active, apiKey, prompt: 'stale' }), error => error.imageOutcome === 'not_requested')
  assert.equal(calls.length, 1)
  const next = await service.capture('webui')
  await service.generate({ ...next.active, apiKey: next.apiKey, prompt: 'redraw' })
  assert.equal(calls[1].steps, 35)
  assert.equal(calls[1].negative_prompt, 'blur')
  await service.configure({ ...next.active, steps: '', guidance: '', negativePrompt: '' })
  const reset = await service.capture('webui')
  await service.generate({ ...reset.active, apiKey: reset.apiKey, prompt: 'default' })
  assert.equal(calls[2].steps, undefined)
})

test('provider dispatch sends advanced controls and preserves them with the returned image', async () => {
  const { generateSceneImage } = await import('../tavern-plugin/lib/domain/scene-image-provider.js')
  const { imageZip } = await import('./fixtures/scene-image-zip.mjs')
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKfoAAAAASUVORK5CYII=', 'base64')
  for (const provider of ['novelai', 'webui', 'qwen']) {
    let sent, count = 0
    const result = await generateSceneImage(config(provider, { steps: '28', guidance: '5.5', negativePrompt: 'watermark' }), { fetch: async (_url, init) => {
      count++; sent = JSON.parse(init.body)
      return provider === 'novelai' ? new Response(imageZip(png)) : Response.json(provider === 'webui' ? { images: [png.toString('base64')] } : { output: { choices: [{ message: { content: [{ image: 'data:image/png;base64,' + png.toString('base64') }] } }] } })
    } })
    assert.equal(count, 1)
    assert.deepEqual(result.data, png)
    assert.equal((provider === 'webui' ? sent : sent.parameters).negative_prompt, 'watermark')
    assert.equal(provider === 'novelai' ? result.metadata.request.parameters.steps : result.metadata.generationParameters.negative_prompt, provider === 'novelai' ? 28 : 'watermark')
  }
})
