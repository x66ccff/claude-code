/**
 * Tavily-based search adapter — calls the official Tavily Search API
 * (https://api.tavily.com) with the user's own API key, or a custom
 * endpoint explicitly configured via settings.tavilyEndpointUrl.
 *
 * There is NO built-in third-party relay: without an explicit endpoint
 * or API key this adapter throws a configuration error instead of
 * silently routing queries through an unknown server.
 */

import axios from 'axios'
import { AbortError } from 'src/utils/errors.js'
import { assertTavilyUsable, resolveTavilyUrl } from '../../shared/tavily.js'
import type { SearchResult, SearchOptions, WebSearchAdapter } from './types.js'

const FETCH_TIMEOUT_MS = 30_000

interface TavilySearchHit {
  title: string
  url: string
  content: string
  score: number
}

interface TavilySearchResponse {
  results: TavilySearchHit[]
}

export class TavilySearchAdapter implements WebSearchAdapter {
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

    const resolved = resolveTavilyUrl('search')
    assertTavilyUsable(resolved)
    const { url: searchUrl, apiKey } = resolved

    try {
      const response = await axios.post<{
        query: string
        results: TavilySearchHit[]
      }>(
        searchUrl,
        {
          query,
          search_depth: 'basic',
          max_results: options.numResults ?? 8,
          include_domains: allowedDomains ?? [],
          exclude_domains: blockedDomains ?? [],
        },
        {
          signal: abortController.signal,
          timeout: FETCH_TIMEOUT_MS,
          headers: {
            'Content-Type': 'application/json',
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          },
        },
      )

      if (abortController.signal.aborted) {
        throw new AbortError()
      }

      const results: SearchResult[] = (response.data.results ?? []).map(
        (hit: TavilySearchHit) => ({
          title: hit.title,
          url: hit.url,
          snippet: hit.content,
        }),
      )

      onProgress?.({
        type: 'search_results_received',
        resultCount: results.length,
        query,
      })

      return results
    } catch (e) {
      if (axios.isCancel(e) || abortController.signal.aborted) {
        throw new AbortError()
      }
      throw e
    }
  }
}
