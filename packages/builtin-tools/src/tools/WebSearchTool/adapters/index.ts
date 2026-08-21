/**
 * Search adapter factory.
 *
 * Priority:
 *   1. WEB_SEARCH_ADAPTER environment override
 *   2. settings.webSearchAdapter selected through /web-tools
 *   3. Serper (machine default)
 */

import { getSettings_DEPRECATED } from 'src/utils/settings/settings.js'
import { ApiSearchAdapter } from './apiAdapter.js'
import { BingSearchAdapter } from './bingAdapter.js'
import { BraveSearchAdapter } from './braveAdapter.js'
import { ExaSearchAdapter } from './exaAdapter.js'
import { SerperSearchAdapter } from './serperAdapter.js'
import { TavilySearchAdapter } from './tavilyAdapter.js'
import type { WebSearchAdapter } from './types.js'

export type {
  SearchOptions,
  SearchProgress,
  SearchResult,
  WebSearchAdapter,
} from './types.js'

export type SearchAdapterKey =
  | 'api'
  | 'bing'
  | 'brave'
  | 'exa'
  | 'serper'
  | 'tavily'

let cachedAdapter: WebSearchAdapter | null = null
let cachedAdapterKey: SearchAdapterKey | null = null

function isSearchAdapterKey(value: unknown): value is SearchAdapterKey {
  return (
    value === 'api' ||
    value === 'bing' ||
    value === 'brave' ||
    value === 'exa' ||
    value === 'serper' ||
    value === 'tavily'
  )
}

export function createAdapter(): WebSearchAdapter {
  const envAdapter = process.env.WEB_SEARCH_ADAPTER
  const settingsAdapter = getSettings_DEPRECATED().webSearchAdapter
  const adapterKey = isSearchAdapterKey(envAdapter)
    ? envAdapter
    : isSearchAdapterKey(settingsAdapter)
      ? settingsAdapter
      : 'serper'

  if (cachedAdapter && cachedAdapterKey === adapterKey) return cachedAdapter

  switch (adapterKey) {
    case 'api':
      cachedAdapter = new ApiSearchAdapter()
      break
    case 'bing':
      cachedAdapter = new BingSearchAdapter()
      break
    case 'brave':
      cachedAdapter = new BraveSearchAdapter()
      break
    case 'exa':
      cachedAdapter = new ExaSearchAdapter()
      break
    case 'tavily':
      cachedAdapter = new TavilySearchAdapter()
      break
    case 'serper':
      cachedAdapter = new SerperSearchAdapter()
      break
  }

  cachedAdapterKey = adapterKey
  return cachedAdapter
}
