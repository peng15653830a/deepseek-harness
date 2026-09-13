import { deflateRawSync } from 'node:zlib'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Config, resolveProvider } from '../src/config.js'
import { DEFAULT_NOVELAI_BASE_URL, DEFAULT_NOVELAI_MODEL } from '../src/shared.js'
import { extractNovelAIImage, generateNovelAIImage, parseNovelAISize } from '../src/novelai.js'
import { describeStudio, generateFromStudio, studioProfile } from '../src/studio.js'
import { parseStudioGenerateRequest } from '../src/studio-route.js'

const webp = Buffer.concat([
  Buffer.from('RIFF'), Buffer.from([0x24, 0x00, 0x00, 0x00]), Buffer.from('WEBP'),
  Buffer.from('VP8L'), Buffer.from([0x10, 0x00, 0x00, 0x00]), Buffer.alloc(16),
])

/** Build a single-entry ZIP whose entry is deflate-compressed, as the endpoint returns one. */
function zip(entryName: string, content: Buffer): Buffer {
  const name = Buffer.from(entryName, 'utf8')
  const deflated = deflateRawSync(content)
  const local = Buffer.alloc(30 + name.length)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(8, 8)
  local.writeUInt32LE(deflated.length, 18)
  local.writeUInt32LE(content.length, 22)
  local.writeUInt16LE(name.length, 26)
  name.copy(local, 30)
  const central = Buffer.alloc(46 + name.length)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(8, 10)
  central.writeUInt32LE(deflated.length, 20)
  central.writeUInt32LE(content.length, 24)
  central.writeUInt16LE(name.length, 28)
  central.writeUInt32LE(0, 42)
  name.copy(central, 46)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(1, 8)
  end.writeUInt16LE(1, 10)
  end.writeUInt32LE(central.length, 12)
  end.writeUInt32LE(local.length + deflated.length, 16)
  return Buffer.concat([local, deflated, central, end])
}

const archived = zip('image_0.webp', webp)

/** Same archive written with the streaming form: sizes live in a trailing data descriptor. */
function zipWithDescriptor(entryName: string, content: Buffer): Buffer {
  const name = Buffer.from(entryName, 'utf8')
  const deflated = deflateRawSync(content)
  const local = Buffer.alloc(30 + name.length)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(0x0008, 6)
  local.writeUInt16LE(8, 8)
  local.writeUInt16LE(name.length, 26)
  name.copy(local, 30)
  const descriptor = Buffer.alloc(16)
  descriptor.writeUInt32LE(0x08074b50, 0)
  descriptor.writeUInt32LE(deflated.length, 8)
  descriptor.writeUInt32LE(content.length, 12)
  const central = Buffer.alloc(46 + name.length)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(0x0008, 8)
  central.writeUInt16LE(8, 10)
  central.writeUInt32LE(deflated.length, 20)
  central.writeUInt32LE(content.length, 24)
  central.writeUInt16LE(name.length, 28)
  central.writeUInt32LE(0, 42)
  name.copy(central, 46)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(1, 8)
  end.writeUInt16LE(1, 10)
  end.writeUInt32LE(central.length, 12)
  end.writeUInt32LE(local.length + deflated.length + descriptor.length, 16)
  return Buffer.concat([local, deflated, descriptor, central, end])
}
const input = () => ({
  apiKey: 'nai_proxy_test-secret', baseURL: DEFAULT_NOVELAI_BASE_URL, model: DEFAULT_NOVELAI_MODEL,
  prompt: '1girl, solo, white background', maxBytes: 4096, timeoutMs: 60_000, signal: new AbortController().signal,
})

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('NovelAI generation adapter', () => {
  it('sends the V4.x request the endpoint requires and unpacks the archived image', async () => {
    const request = vi.fn(async () => new Response(archived, { status: 201 }))
    vi.stubGlobal('fetch', request)
    const result = await generateNovelAIImage({ ...input(), size: '2:3', negativePrompt: 'lowres', seed: 42 })

    expect(Buffer.from(result.data)).toEqual(webp)
    expect(result.mediaType).toBe('image/webp')
    expect(result.seed).toBe(42)
    const [url, init] = request.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://image.novelai.net/ai/generate-image')
    expect(init.redirect).toBe('error')
    expect(init.headers).toMatchObject({ authorization: 'Bearer nai_proxy_test-secret' })
    const body = JSON.parse(init.body as string) as { input: string; action: string; parameters: Record<string, unknown> }
    expect(body).toMatchObject({ input: input().prompt, model: DEFAULT_NOVELAI_MODEL, action: 'generate' })
    expect(body.parameters).toMatchObject({
      params_version: 3, width: 832, height: 1216, steps: 28, seed: 42, negative_prompt: 'lowres',
      v4_prompt: { caption: { base_caption: input().prompt, char_captions: [] }, use_coords: false, use_order: true },
      v4_negative_prompt: { caption: { base_caption: 'lowres', char_captions: [] }, legacy_uc: false },
    })
  })

  it('accepts an unarchived image and rejects payloads that carry none', async () => {
    expect(extractNovelAIImage(webp)).toMatchObject({ mediaType: 'image/webp' })
    expect(extractNovelAIImage(Buffer.concat([webp, Buffer.alloc(4)]))).toMatchObject({ mediaType: 'image/webp' })
    expect(() => extractNovelAIImage(Buffer.from('{"message":"无效的请求"}'))).toThrow('无法识别的图片数据')
    expect(extractNovelAIImage(zip('image_0.webp', webp))).toMatchObject({ mediaType: 'image/webp' })
    expect(Buffer.from(extractNovelAIImage(zipWithDescriptor('image_0.webp', webp)).data)).toEqual(webp)
  })

  it('rejects sizes outside the supported grid before sending', () => {
    expect(parseNovelAISize('9:16')).toEqual({ width: 768, height: 1344 })
    expect(parseNovelAISize(undefined)).toEqual({ width: 1024, height: 1024 })
    expect(parseNovelAISize('512x768')).toEqual({ width: 512, height: 768 })
    for (const size of ['832*1216', '832x1217', '64x64', '4096x4096', '2048x2048']) {
      expect(() => parseNovelAISize(size)).toThrow()
    }
  })

  it('rejects secret-bearing URLs and empty credentials without a request', async () => {
    const request = vi.fn(); vi.stubGlobal('fetch', request)
    for (const patch of [
      { baseURL: 'https://relay.example/api?key=secret' },
      { baseURL: 'https://user:pw@relay.example' },
      { apiKey: '' },
      { model: '' },
      { prompt: '  ' },
      { size: '1024x1024x1024' },
    ]) {
      await expect(generateNovelAIImage({ ...input(), ...patch })).rejects.toThrow()
    }
    expect(request).not.toHaveBeenCalled()
  })

  it.each([401, 400, 500, 404])('maps HTTP %s without retrying or echoing the response', async status => {
    const request = vi.fn(async () => new Response('nai_proxy_test-secret private prompt', { status }))
    vi.stubGlobal('fetch', request)
    await expect(generateNovelAIImage(input())).rejects.toThrow(`HTTP ${String(status)}`)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('waits out a full queue and succeeds on the retry', async () => {
    vi.useFakeTimers()
    const request = vi.fn()
      .mockResolvedValueOnce(Response.json({ message: '队列已满，请稍后重试' }, { status: 503 }))
      .mockResolvedValueOnce(new Response(archived, { status: 201 }))
    vi.stubGlobal('fetch', request)
    const pending = generateNovelAIImage(input())
    await vi.advanceTimersByTimeAsync(15_000)
    expect((await pending).mediaType).toBe('image/webp')
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('stops retrying once the deadline cannot cover another wait', async () => {
    vi.useFakeTimers()
    const request = vi.fn(async () => Response.json({ message: '队列已满，请稍后重试' }, { status: 503 }))
    vi.stubGlobal('fetch', request)
    const pending = generateNovelAIImage({ ...input(), timeoutMs: 20_000 })
    const settled = expect(pending).rejects.toThrow('队列已满')
    await vi.advanceTimersByTimeAsync(20_000)
    await settled
    expect(request).toHaveBeenCalledTimes(2)
  })
})

describe('NovelAI plugin configuration and Studio', () => {
  it('has isolated schema, model, endpoint and credential', () => {
    expect(Config({ provider: 'novelai' })).toMatchObject({
      novelaiBaseURL: DEFAULT_NOVELAI_BASE_URL, novelaiModel: DEFAULT_NOVELAI_MODEL, novelaiNegativePrompt: '',
    })
    expect(resolveProvider({ provider: 'novelai', novelaiModel: 'nai-diffusion-4-full', novelaiBaseURL: 'https://relay.example', openaiModel: 'not-novelai' }))
      .toMatchObject({ provider: 'novelai', apiKeyEnv: 'NOVELAI_API_KEY', model: 'nai-diffusion-4-full', baseURL: 'https://relay.example', imageSize: '1024x1024' })
    const profile = studioProfile({}, 'novelai', true)
    expect(profile).toMatchObject({ supportsEditing: false, defaultRatio: '2:3', defaultQuality: 'standard' })
    expect(profile.ratioOptions.map(option => option.value)).toEqual(['1:1', '3:2', '2:3', '16:9', '9:16'])
    expect(profile.ratioOptions[1]).toEqual({ value: '3:2', label: '3:2 横向' })
  })

  it('passes through the Studio contract, reads the plugin Key and saves one DSH attachment', async () => {
    const request = vi.fn(async () => new Response(archived, { status: 201 }))
    vi.stubGlobal('fetch', request)
    const saveImage = vi.fn(async () => ({ attachmentId: 'sha256:test', mediaType: 'image/webp', bytes: webp.length, width: 1, height: 1 }))
    const ctx = { credentials: { resolve: vi.fn(async () => ({ value: 'nai_proxy_test-secret' })) },
      attachments: { imageLimits: { maxImageBytes: 4096, mediaTypes: ['image/webp'] }, saveImage }, logger: { warn: vi.fn() } } as unknown as Context
    const config = { provider: 'novelai' as const, saveToWorkspace: false, novelaiNegativePrompt: 'lowres' }

    const catalog = await describeStudio(ctx, config)
    expect(catalog.activeProvider).toBe('novelai')
    expect(catalog.providers.find(profile => profile.provider === 'novelai')).toMatchObject({ label: 'NovelAI', configured: true })
    expect(JSON.stringify(catalog)).not.toContain('nai_proxy_test-secret')
    expect(request).not.toHaveBeenCalled()

    const req = parseStudioGenerateRequest({ mode: 'generate', provider: 'novelai', model: DEFAULT_NOVELAI_MODEL, prompt: input().prompt, ratio: '2:3', quality: 'standard' })
    const result = await generateFromStudio(ctx, config, req, input().signal)
    expect(result).toMatchObject({ provider: 'novelai', model: DEFAULT_NOVELAI_MODEL, output: '832x1216', attachment: { attachmentId: 'sha256:test' } })
    expect(saveImage).toHaveBeenCalledTimes(1)
    const body = JSON.parse((request.mock.calls[0] as unknown as [string, RequestInit])[1].body as string) as { parameters: Record<string, unknown> }
    expect(body.parameters).toMatchObject({ width: 832, height: 1216, negative_prompt: 'lowres' })

    await expect(generateFromStudio(ctx, config, { ...req, mode: 'edit' }, input().signal)).rejects.toThrow('不支持图生图')
    await expect(generateFromStudio(ctx, config, { ...req, model: 'changed' }, input().signal)).rejects.toThrow('模型配置已变化')
    expect(request).toHaveBeenCalledTimes(1)
  })
})
