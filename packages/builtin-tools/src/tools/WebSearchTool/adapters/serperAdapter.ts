/**
 * Serper-backed search adapter.
 *
 * Uses Serper's Google Search API while preserving Claude Code's native
 * WebSearch tool schema and UI. Authentication is read only from the process
 * environment so cloud and local-model launchers can share this adapter
 * without copying credentials into Claude settings.
 */

import axios from 'axios'
import { AbortError } from 'src/utils/errors.js'
import type { SearchOptions, SearchResult, WebSearchAdapter } from './types.js'

const FETCH_TIMEOUT_MS = 30_000
const DEFAULT_SERPER_SEARCH_URL = 'https://google.serper.dev/search'

interface SerperLinkResult {
  title?: string
  link?: string
  snippet?: string
}

interface SerperResponse {
  answerBox?: SerperLinkResult
  knowledgeGraph?: {
    title?: string
    website?: string
    description?: string
  }
  organic?: SerperLinkResult[]
  news?: SerperLinkResult[]
}

export class SerperSearchAdapter implements WebSearchAdapter {
  async search(query: string, options: SearchOptions): Promise<SearchResult[]> {
    const { signal, onProgress, allowedDomains, blockedDomains } = options

    if (signal?.aborted) {
      throw new AbortError()
    }

    onProgress?.({ type: 'query_update', query })

    const abortController = new AbortController()
    if (signal) {
      signal.addEventListener('abort', () => abortController.abort(), {
        once: true,
      })
    }

    let payload: SerperResponse
    try {
      const response = await axios.post<SerperResponse>(
        getSerperSearchUrl(),
        {
          q: query,
          num: clampResultCount(options.numResults),
        },
        {
          signal: abortController.signal,
          timeout: FETCH_TIMEOUT_MS,
          responseType: 'json',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'X-API-KEY': getSerperApiKey(),
          },
        },
      )
      payload = response.data
    } catch (error) {
      if (axios.isCancel(error) || abortController.signal.aborted) {
        throw new AbortError()
      }
      throw classifySerperError(error)
    }

    if (abortController.signal.aborted) {
      throw new AbortError()
    }

    const results = extractSerperResults(payload).filter(result =>
      matchesDomainFilters(result.url, allowedDomains, blockedDomains),
    )

    onProgress?.({
      type: 'search_results_received',
      resultCount: results.length,
      query,
    })

    return results
  }
}

export function extractSerperResults(payload: SerperResponse): SearchResult[] {
  const candidates: SerperLinkResult[] = [
    ...(payload.answerBox ? [payload.answerBox] : []),
    ...(payload.knowledgeGraph?.website
      ? [
          {
            title: payload.knowledgeGraph.title,
            link: payload.knowledgeGraph.website,
            snippet: payload.knowledgeGraph.description,
          },
        ]
      : []),
    ...(Array.isArray(payload.organic) ? payload.organic : []),
    ...(Array.isArray(payload.news) ? payload.news : []),
  ]

  const seenUrls = new Set<string>()
  const results: SearchResult[] = []

  for (const candidate of candidates) {
    const url = candidate.link?.trim()
    if (!url || seenUrls.has(url) || !isHttpUrl(url)) {
      continue
    }

    seenUrls.add(url)
    results.push({
      title: candidate.title?.trim() || url,
      url,
      snippet: candidate.snippet?.trim() || undefined,
    })
  }

  return results
}

function getSerperApiKey(): string {
  const apiKey = process.env.SERPER_API_KEY?.trim()
  if (apiKey) {
    return apiKey
  }

  throw new Error(
    'Serper Web Search is not configured. Set SERPER_API_KEY and restart Claude Code.',
  )
}

function getSerperSearchUrl(): string {
  return process.env.SERPER_API_URL?.trim() || DEFAULT_SERPER_SEARCH_URL
}

function clampResultCount(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) {
    return 8
  }
  return Math.max(1, Math.min(100, Math.round(requested)))
}

function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

function matchesDomainFilters(
  url: string,
  allowedDomains: string[] | undefined,
  blockedDomains: string[] | undefined,
): boolean {
  let hostname: string
  try {
    hostname = new URL(url).hostname.toLowerCase()
  } catch {
    return false
  }

  const matches = (domain: string): boolean => {
    const normalized = domain
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .split('/')[0]
      ?.replace(/^\*\./, '')
    return (
      !!normalized &&
      (hostname === normalized || hostname.endsWith(`.${normalized}`))
    )
  }

  if (allowedDomains?.length && !allowedDomains.some(matches)) {
    return false
  }
  if (blockedDomains?.length && blockedDomains.some(matches)) {
    return false
  }
  return true
}

function classifySerperError(error: unknown): Error {
  if (!axios.isAxiosError(error)) {
    const detail = error instanceof Error ? error.message : String(error)
    return new Error(`Serper Web Search failed: ${detail}`)
  }

  const status = error.response?.status
  const detail = getApiErrorDetail(error.response?.data)
  const detailSuffix = detail ? ` (${detail})` : ''
  const looksLikeQuota = detail
    ? /credit|quota|balance|exhaust|limit reached|insufficient/i.test(detail)
    : false

  if (status === 402 || looksLikeQuota) {
    return new Error(
      `Serper Web Search credits are exhausted or unavailable. Top up the Serper account, then retry.${detailSuffix}`,
    )
  }
  if (status === 401 || status === 403) {
    return new Error(
      `Serper Web Search rejected the API key. Check SERPER_API_KEY and restart Claude Code.${detailSuffix}`,
    )
  }
  if (status === 429) {
    return new Error(
      `Serper Web Search rate limit was reached. Wait briefly and retry; if it persists, check the account credits.${detailSuffix}`,
    )
  }
  if (status !== undefined && status >= 500) {
    return new Error(
      `Serper Web Search is temporarily unavailable (HTTP ${status}). Retry later.${detailSuffix}`,
    )
  }
  if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
    return new Error(
      'Serper Web Search timed out after 30 seconds. Check the network connection and retry.',
    )
  }
  if (!error.response) {
    return new Error(
      `Serper Web Search could not reach the API. Check the network or proxy and retry.${detailSuffix}`,
    )
  }

  return new Error(
    `Serper Web Search failed with HTTP ${status ?? 'unknown'}.${detailSuffix}`,
  )
}

function getApiErrorDetail(data: unknown): string | undefined {
  if (typeof data === 'string') {
    return sanitizeErrorDetail(data)
  }
  if (typeof data !== 'object' || data === null) {
    return undefined
  }

  const record = data as Record<string, unknown>
  for (const key of ['message', 'error', 'detail']) {
    const value = record[key]
    if (typeof value === 'string') {
      return sanitizeErrorDetail(value)
    }
    if (typeof value === 'object' && value !== null) {
      const nestedMessage = (value as Record<string, unknown>)['message']
      if (typeof nestedMessage === 'string') {
        return sanitizeErrorDetail(nestedMessage)
      }
    }
  }
  return undefined
}

function sanitizeErrorDetail(detail: string): string | undefined {
  const normalized = detail.replace(/\s+/g, ' ').trim().slice(0, 240)
  return normalized || undefined
}
