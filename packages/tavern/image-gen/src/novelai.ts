/**
 * NovelAI image adapter for the official `/ai/generate-image` protocol.
 *
 * The endpoint expects the full V4.x parameter set (including the `v4_prompt` /
 * `v4_negative_prompt` captions) and answers with a ZIP archive holding the
 * rendered image. Relays built on the same protocol reject a request while their
 * shared queue is full, so a queue-full or rate-limited response is retried on a
 * fixed schedule instead of failing the whole generation.
 */
import { randomInt } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'

/** Ratios the workbench exposes; `NOVELAI_SIZES` owns their reference dimensions. */
export const NOVELAI_RATIOS = ['1:1', '3:2', '2:3', '16:9', '9:16'] as const

/** Reference dimensions per ratio: NovelAI's documented dimensions for each frame. */
export const NOVELAI_SIZES: Record<string, string> = {
  '1:1': '1024x1024',
  '3:2': '1216x832',
  '2:3': '832x1216',
  '16:9': '1344x768',
  '9:16': '768x1344',
}

/** Dimensions used when a request carries no size. */
export const DEFAULT_NOVELAI_SIZE = '1024x1024'

/** Sampling parameters fixed by the adapter; a deployment changes them in code, not config. */
export const NOVELAI_STEPS = 28
export const NOVELAI_SAMPLER = 'k_euler_ancestral'
export const NOVELAI_SCALE = 5

/** NovelAI accepts dimensions on a 64-pixel grid inside these bounds. */
const DIMENSION_STEP = 64
const MIN_DIMENSION = 256
const MAX_DIMENSION = 2048
const MAX_PIXELS = 3_000_000

/** Waits before re-sending after a queue-full (503) or rate-limited (429) response. */
const RETRY_DELAYS_MS = [15_000, 30_000] as const

/** Archive metadata allowed on top of the image byte limit of one response body. */
const ARCHIVE_OVERHEAD_BYTES = 1024 * 1024

/** One NovelAI text-to-image request. */
export interface NovelAIGenerateInput {
  apiKey: string
  /** API root; the adapter appends `/ai/generate-image`. */
  baseURL: string
  model: string
  prompt: string
  /** `WxH` dimensions or a ratio in `NOVELAI_RATIOS`; omitted means `1:1`. */
  size?: string | undefined
  negativePrompt?: string | undefined
  /** Concrete seed for reproducible results; omitted means a random seed. */
  seed?: number | undefined
  /** Deadline covering every queue retry of this generation. */
  timeoutMs: number
  maxBytes: number
  signal: AbortSignal
}

/** Render one image and return its bytes with the seed that produced it. */
export async function generateNovelAIImage(
  input: NovelAIGenerateInput,
): Promise<{ data: Uint8Array; mediaType: ImageMediaType; seed: number }> {
  const endpoint = novelaiEndpoint(input.baseURL)
  if (!input.apiKey.trim() || /[\r\n]/.test(input.apiKey)) throw new Error('请配置有效的 NovelAI API Key')
  if (!input.model.trim()) throw new Error('NovelAI 模型不能为空')
  if (!input.prompt.trim()) throw new Error('NovelAI 提示词不能为空')
  const { width, height } = parseNovelAISize(input.size)
  const seed = input.seed ?? randomInt(0, 4_294_967_296)
  const body = JSON.stringify(novelaiPayload({
    model: input.model, prompt: input.prompt, negativePrompt: input.negativePrompt ?? '',
    width, height, seed,
  }))

  const deadline = Date.now() + input.timeoutMs
  for (let attempt = 0; ; attempt += 1) {
    input.signal.throwIfAborted()
    const response = await postGeneration(endpoint, input, body, deadline)
    if (response.ok) {
      const payload = await readCapped(response, input.maxBytes + ARCHIVE_OVERHEAD_BYTES, input.signal)
      const image = extractNovelAIImage(payload)
      if (image.data.byteLength === 0 || image.data.byteLength > input.maxBytes) throw new Error('NovelAI 图片为空或超过大小限制')
      return { ...image, seed }
    }
    // Never echo provider response text: it may carry credentials or the prompt.
    const status = response.status
    await response.body?.cancel().catch(() => {})
    if (status !== 503 && status !== 429) {
      if (status === 401 || status === 403) throw new Error(`NovelAI 拒绝了本次请求（HTTP ${String(status)}）：API Key 无效或没有生图额度`)
      if (status === 400 || status === 422) throw new Error(`NovelAI 拒绝了本次请求（HTTP ${String(status)}）：请检查模型名、尺寸与参数组合`)
      throw new Error(`NovelAI 生图请求失败（HTTP ${String(status)}）`)
    }
    const delayMs = RETRY_DELAYS_MS[attempt]
    if (delayMs === undefined || Date.now() + delayMs >= deadline) {
      throw new Error(`NovelAI 队列已满或触发限流（HTTP ${String(status)}）；这是中转的共享排队，请稍后重试`)
    }
    await delay(delayMs, input.signal)
  }
}

/** Return the image held by a generation response: raw image bytes or the image inside its archive. */
export function extractNovelAIImage(payload: Uint8Array): { data: Uint8Array; mediaType: ImageMediaType } {
  const direct = imageMediaType(payload)
  if (direct !== undefined) return { data: payload, mediaType: direct }
  if (payload.length < 4 || payload[0] !== 0x50 || payload[1] !== 0x4b) {
    throw new Error('NovelAI 返回了无法识别的图片数据')
  }
  const entry = firstArchiveEntry(payload)
  if (entry === undefined) throw new Error('NovelAI 返回的压缩包中没有图片条目')
  const mediaType = imageMediaType(entry)
  if (mediaType === undefined) throw new Error('NovelAI 返回了不支持的图片格式')
  return { data: entry, mediaType }
}

/** Resolve the request dimensions from `WxH` text or a known ratio. */
export function parseNovelAISize(size: string | undefined): { width: number; height: number } {
  const requested = (size ?? '').trim()
  const text = NOVELAI_SIZES[requested] ?? (requested.length > 0 ? requested : DEFAULT_NOVELAI_SIZE)
  const match = /^(\d{2,5})x(\d{2,5})$/.exec(text)
  if (match === null) throw new Error('NovelAI 尺寸必须是「宽x高」（例如 832x1216）或受支持的画面比例')
  const width = Number(match[1])
  const height = Number(match[2])
  if (width % DIMENSION_STEP !== 0 || height % DIMENSION_STEP !== 0) throw new Error(`NovelAI 宽高必须是 ${String(DIMENSION_STEP)} 的整数倍`)
  if (width < MIN_DIMENSION || height < MIN_DIMENSION || width > MAX_DIMENSION || height > MAX_DIMENSION) {
    throw new Error(`NovelAI 宽高需在 ${String(MIN_DIMENSION)}~${String(MAX_DIMENSION)} 之间`)
  }
  if (width * height > MAX_PIXELS) throw new Error(`NovelAI 总像素不能超过 ${String(MAX_PIXELS / 1_000_000)}M（当前 ${String(width)}x${String(height)}）`)
  return { width, height }
}

/** Validate the API root and append the generation path. */
function novelaiEndpoint(baseURL: string): string {
  const base = new URL(baseURL)
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error('NovelAI API 根地址必须是无账号、查询参数或片段的 HTTP(S) 地址')
  }
  return `${base.href.replace(/\/+$/, '')}/ai/generate-image`
}

/** Build the request body the protocol requires for a V4.x model. */
function novelaiPayload(input: {
  model: string; prompt: string; negativePrompt: string; width: number; height: number; seed: number
}): Record<string, unknown> {
  const caption = { base_caption: input.prompt, char_captions: [] as unknown[] }
  const negativeCaption = { base_caption: input.negativePrompt, char_captions: [] as unknown[] }
  return {
    input: input.prompt,
    model: input.model,
    action: 'generate',
    parameters: {
      params_version: 3,
      width: input.width,
      height: input.height,
      scale: NOVELAI_SCALE,
      sampler: NOVELAI_SAMPLER,
      steps: NOVELAI_STEPS,
      seed: input.seed,
      n_samples: 1,
      ucPreset: 0,
      qualityToggle: true,
      dynamic_thresholding: false,
      controlnet_strength: 1,
      legacy: false,
      add_original_image: false,
      cfg_rescale: 0,
      noise_schedule: 'karras',
      legacy_v3_extend: false,
      use_coords: false,
      negative_prompt: input.negativePrompt,
      v4_prompt: { caption, use_coords: false, use_order: true },
      v4_negative_prompt: { caption: negativeCaption, legacy_uc: false },
    },
  }
}

/** Send one attempt under the remaining deadline and the caller's signal. */
async function postGeneration(
  endpoint: string,
  input: NovelAIGenerateInput,
  body: string,
  deadline: number,
): Promise<Response> {
  const controller = new AbortController()
  const forward = (): void => { controller.abort(input.signal.reason) }
  input.signal.addEventListener('abort', forward, { once: true })
  const timer = setTimeout(() => { controller.abort(new Error('novelai-timeout')) }, Math.max(1, deadline - Date.now()))
  try {
    return await fetch(endpoint, {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { authorization: `Bearer ${input.apiKey}`, 'content-type': 'application/json' },
      body,
    })
  } catch (error) {
    input.signal.throwIfAborted()
    if (deadline <= Date.now()) throw new Error('NovelAI 生图超时；请调高设置中的超时时间或稍后重试')
    throw error
  } finally {
    clearTimeout(timer)
    input.signal.removeEventListener('abort', forward)
  }
}

/** Read a response body, refusing anything beyond the byte limit. */
async function readCapped(response: Response, limit: number, signal: AbortSignal): Promise<Uint8Array> {
  const reader = response.body?.getReader()
  if (reader === undefined) throw new Error('NovelAI 未返回图片')
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > limit) throw new Error('NovelAI 图片响应过大')
      chunks.push(value)
    }
  } finally {
    signal.throwIfAborted()
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  return Buffer.concat(chunks)
}

/** Identify the image type from leading magic bytes. */
function imageMediaType(data: Uint8Array): ImageMediaType | undefined {
  if (data.length > 8 && Buffer.from(data.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (data.length > 3 && data[0] === 255 && data[1] === 216 && data[2] === 255) return 'image/jpeg'
  if (data.length > 12 && Buffer.from(data.subarray(0, 4)).toString('ascii') === 'RIFF' && Buffer.from(data.subarray(8, 12)).toString('ascii') === 'WEBP') return 'image/webp'
  if (data.length > 6 && Buffer.from(data.subarray(0, 3)).toString('ascii') === 'GIF') return 'image/gif'
  return undefined
}

/**
 * Return the first image entry of a ZIP archive, reading the central directory
 * so entries written with their sizes deferred to a trailing descriptor work too.
 */
function firstArchiveEntry(archive: Uint8Array): Uint8Array | undefined {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength)
  const endOfDirectory = findEndOfDirectory(view)
  if (endOfDirectory === undefined) return undefined
  const entryCount = view.getUint16(endOfDirectory + 10, true)
  let cursor = view.getUint32(endOfDirectory + 16, true)
  let first: Uint8Array | undefined
  for (let index = 0; index < entryCount && cursor + 46 <= archive.byteLength; index += 1) {
    if (view.getUint32(cursor, true) !== 0x02014b50) return first
    const method = view.getUint16(cursor + 10, true)
    const compressedSize = view.getUint32(cursor + 20, true)
    const nameLength = view.getUint16(cursor + 28, true)
    const extraLength = view.getUint16(cursor + 30, true)
    const commentLength = view.getUint16(cursor + 32, true)
    const localOffset = view.getUint32(cursor + 42, true)
    const name = Buffer.from(archive.subarray(cursor + 46, cursor + 46 + nameLength)).toString('utf8')
    const entry = readArchiveEntry(archive, view, localOffset, method, compressedSize)
    if (entry !== undefined) {
      if (first === undefined) first = entry
      if (/\.(png|jpe?g|webp|gif)$/i.test(name)) return entry
    }
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return first
}

/** Inflate one central-directory entry from its local header. */
function readArchiveEntry(
  archive: Uint8Array,
  view: DataView,
  localOffset: number,
  method: number,
  compressedSize: number,
): Uint8Array | undefined {
  if (localOffset + 30 > archive.byteLength || view.getUint32(localOffset, true) !== 0x04034b50) return undefined
  const nameLength = view.getUint16(localOffset + 26, true)
  const extraLength = view.getUint16(localOffset + 28, true)
  const start = localOffset + 30 + nameLength + extraLength
  const stored = archive.subarray(start, start + compressedSize)
  if (stored.byteLength !== compressedSize) return undefined
  if (method === 0) return stored
  if (method !== 8) return undefined
  try {
    return inflateRawSync(stored)
  } catch {
    // A corrupt entry means this archive carries no usable image; the caller reports the format error.
    return undefined
  }
}

/** Locate the end-of-central-directory record of a ZIP archive. */
function findEndOfDirectory(view: DataView): number | undefined {
  const minimum = Math.max(0, view.byteLength - 65_557)
  for (let offset = view.byteLength - 22; offset >= minimum; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) return offset
  }
  return undefined
}

/** Wait without losing abort responsiveness. */
async function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, milliseconds)
    const abort = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      reject(signal.reason as Error)
    }
    function done(): void {
      signal.removeEventListener('abort', abort)
      resolve()
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}
