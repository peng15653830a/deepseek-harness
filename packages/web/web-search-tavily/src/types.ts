/**
 * Wire types for the Tavily search API (`POST https://api.tavily.com/search`).
 * Types only — no runtime code. Tavily returns a flat `results[]`; each entry
 * carries a URL, optional title, optional `published_date`, and an extracted
 * `content` excerpt. An optional generated `answer` may precede the results.
 *
 * @module @deepseek-ai/dsh-web-search-tavily/types
 */

/** Request body sent to Tavily's search endpoint. */
export interface TavilySearchRequest {
  query: string
  /** Retrieval depth: `basic` (fast) or `advanced` (deeper crawl). */
  search_depth: 'basic' | 'advanced'
  /** Ask Tavily for a short generated answer over the results. */
  include_answer: boolean
  /** Tavily's result-count control; the seam still enforces the bound on return. */
  max_results?: number
}

/** One entry of Tavily's flat `results[]`. */
export interface TavilyResult {
  url: string
  title?: string | null
  content?: string | null
  published_date?: string | null
}

/** Tavily's search response envelope. */
export interface TavilySearchResponse {
  query?: string
  answer?: string | null
  results?: TavilyResult[]
}

/** Tavily's error response envelope (best-effort; fields vary by failure). */
export interface TavilyError {
  detail?: string
  error?: string
  message?: string
}
