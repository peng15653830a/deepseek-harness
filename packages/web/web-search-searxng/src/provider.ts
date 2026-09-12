/**
 * `SearxngSearchProvider`: a `WebSearchProvider` backed by a SearXNG instance
 * (`GET /search?format=json`). SearXNG aggregates public search engines locally
 * and needs no API key, so availability is a base-URL config check. It maps
 * each result's `content` to `snippet` and `publishedDate` to `publishedAt`,
 * keeps snippet-less entries as URL/title citations, and joins any non-blank
 * instant `answers` into the result `content`.
 * @module @deepseek-ai/dsh-web-search-searxng/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import type { SearxngError, SearxngResult, SearxngSearchResponse } from './types.ts'

/** Stable id this provider registers under. */
export const SEARXNG_PROVIDER_ID = 'searxng'

/** Default SearXNG endpoint on loopback; `/search` is the operation. */
export const SEARXNG_DEFAULT_BASE_URL = 'http://127.0.0.1:8888'

/** Attribution header sent on every request. Bump with the package version. */
const USER_AGENT = 'deepseek-harness/0.0.1'

/** Resolved provider options (the plugin's `apply` supplies the constant default). */
export interface SearxngSearchProviderOptions {
  /** SearXNG instance base; `/search` is appended. */
  baseURL: string
}

/**
 * Map one SearXNG result to a normalized source. A blank `content` yields a
 * URL/title citation rather than a dropped entry: the seam's citation shape is
 * optional-snippet, and SearXNG results are engine-vetted URLs.
 *
 * @param result - one entry of SearXNG's `results[]`.
 * @returns the normalized source.
 */
export function mapSearxngResult(result: SearxngResult): WebSearchSource {
  return {
    url: result.url,
    ...result.title != null && result.title.length > 0 ? { title: result.title } : {},
    ...result.content != null && result.content.length > 0 ? { snippet: result.content } : {},
    ...result.publishedDate != null && result.publishedDate.length > 0 ? { publishedAt: result.publishedDate } : {},
  }
}

/**
 * Map a SearXNG response envelope to a normalized search result.
 *
 * @param response - the parsed `GET /search?format=json` response body.
 * @returns the normalized result; non-blank instant `answers` are joined into
 *   the result `content`, and the web service owns the final `maxResults`
 *   truncation, so this provider reports `truncated: false`.
 */
export function mapSearxngResponse(response: SearxngSearchResponse): WebSearchResult {
  const answers = (response.answers ?? [])
    .filter((answer): answer is string => answer != null && answer.trim().length > 0)
  return {
    ...answers.length > 0 ? { content: answers.join('\n') } : {},
    sources: (response.results ?? []).map(mapSearxngResult),
    truncated: false,
  }
}

/** The SearXNG-backed search provider; HTTP redirects fail as `WEB_PROVIDER_ERROR`. */
export class SearxngSearchProvider implements WebSearchProvider {
  readonly id = SEARXNG_PROVIDER_ID

  constructor(private readonly options: SearxngSearchProviderOptions) {}

  available(): boolean {
    return isValidBaseUrl(this.options.baseURL)
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    // SearXNG's /search has no result-count parameter; the seam enforces the
    // request's maxResults bound on the way back.
    const url = `${this.options.baseURL}/search?q=${encodeURIComponent(request.query)}&format=json`
    let response: Response
    try {
      response = await fetch(url, {
        method: 'GET',
        redirect: 'error',
        headers: {
          'accept': 'application/json',
          'user-agent': USER_AGENT,
        },
        ...signal !== undefined ? { signal } : {},
      })
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('SearXNG search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`Searxng search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }

    if (!response.ok) {
      const status = response.status
      let message = `Searxng API error (HTTP ${status})`
      try {
        const detail = await parseSearxngError(response)
        if (detail.length > 0) message = detail
      } catch (error: unknown) {
        // An abort fired mid-body must surface as WEB_ABORTED, not be swallowed
        // into a generic HTTP-error message (the seam's cancellation contract).
        if (isAbortError(error)) throw new WebError('Searxng search aborted', 'WEB_ABORTED', { cause: error })
      }
      throw new WebError(message, 'WEB_PROVIDER_ERROR')
    }

    try {
      const payload = await response.json() as SearxngSearchResponse
      return mapSearxngResponse(payload)
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('Searxng search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`Searxng returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
  }
}

/**
 * Best-effort error detail: a JSON envelope's `detail`/`error`/`message` field
 * when the body parses as JSON, else the raw text body (SearXNG answers its
 * error paths, such as the JSON-format-disabled 403, with plain text).
 *
 * @param response - the failed response whose body carries the detail.
 * @returns the provider-supplied detail, or `''` for an empty body.
 */
async function parseSearxngError(response: Response): Promise<string> {
  const text = await response.text()
  if (text.length === 0) return ''
  try {
    const parsed = JSON.parse(text) as SearxngError
    const detail = parsed.detail ?? parsed.error ?? parsed.message
    return typeof detail === 'string' && detail.length > 0 ? detail : ''
  } catch {
    // A non-JSON body is normal for SearXNG error paths; the raw text is the message.
  }
  return text
}

/** True when `baseURL` parses as an absolute URL (a cheap local config check). */
function isValidBaseUrl(baseURL: string): boolean {
  return URL.canParse(baseURL)
}

/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}
