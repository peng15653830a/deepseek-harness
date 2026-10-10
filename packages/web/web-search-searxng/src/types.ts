/**
 * Wire types for a SearXNG JSON search response (`GET /search?format=json`).
 * Types only — no runtime code. SearXNG returns a flat `results[]`; each entry
 * carries a URL, an optional title, an optional `content` excerpt, and an
 * optional `publishedDate`. An optional `answers` array may carry plain-text
 * instant answers.
 *
 * @module @deepseek-ai/dsh-web-search-searxng/types
 */

/** One entry of SearXNG's flat `results[]`. */
export interface SearxngResult {
  url: string
  title?: string | null
  /** Snippet text; some engine results carry none. */
  content?: string | null
  /** Publication timestamp when the source engine supplies one. */
  publishedDate?: string | null
}

/** SearXNG's search response envelope. */
export interface SearxngSearchResponse {
  query?: string
  answers?: (string | null)[]
  results?: SearxngResult[]
}

/** SearXNG's error response envelope (best-effort; the JSON API may also answer with plain text). */
export interface SearxngError {
  detail?: string
  error?: string
  message?: string
}
