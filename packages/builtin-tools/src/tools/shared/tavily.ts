/**
 * Shared Tavily endpoint/key resolution for WebSearch (tavily adapter)
 * and WebFetch (tavily extract backend).
 *
 * Policy: there is NO built-in third-party relay. Resolution order:
 *   1. settings.tavilyEndpointUrl — user-configured custom endpoint.
 *   2. Official Tavily API (https://api.tavily.com), which requires the
 *      user's own API key via settings.tavilyApiKey or env TAVILY_API_KEY.
 *
 * When neither is configured, Tavily is "not configured": callers either
 * throw a clear configuration error or fall back to key-free backends
 * (Bing scrape for search, direct HTTP for fetch).
 */

import { getSettings_DEPRECATED } from 'src/utils/settings/settings.js'

export const OFFICIAL_TAVILY_BASE_URL = 'https://api.tavily.com'

interface TavilySettings {
  tavilyEndpointUrl?: string
  tavilyApiKey?: string
}

function readTavilySettings(): TavilySettings {
  return getSettings_DEPRECATED() as Record<string, unknown> & TavilySettings
}

/** Tavily API key: settings.tavilyApiKey > env TAVILY_API_KEY. */
export function getTavilyApiKey(): string | undefined {
  const settings = readTavilySettings()
  return settings.tavilyApiKey || process.env.TAVILY_API_KEY || undefined
}

/**
 * Whether Tavily is usable: an explicit custom endpoint, or an API key
 * for the official Tavily API.
 */
export function isTavilyConfigured(): boolean {
  const settings = readTavilySettings()
  return Boolean(settings.tavilyEndpointUrl || getTavilyApiKey())
}

/**
 * Resolve the concrete Tavily URL for a given API kind.
 * A custom endpoint may already end with /search or /extract (legacy
 * configs stored the full path) — normalize to the requested kind.
 */
export function resolveTavilyUrl(kind: 'search' | 'extract'): {
  url: string
  apiKey: string | undefined
  isOfficial: boolean
} {
  const settings = readTavilySettings()
  const apiKey = getTavilyApiKey()
  const custom = settings.tavilyEndpointUrl?.trim()

  if (custom) {
    const base = custom.replace(/\/$/, '')
    const url =
      base.endsWith('/search') || base.endsWith('/extract')
        ? base.replace(/\/(search|extract)$/, `/${kind}`)
        : `${base}/${kind}`
    return { url, apiKey, isOfficial: false }
  }

  return {
    url: `${OFFICIAL_TAVILY_BASE_URL}/${kind}`,
    apiKey,
    isOfficial: true,
  }
}

/**
 * Throw a configuration error when the official endpoint would be used
 * without an API key (never silently route through an unknown server).
 */
export function assertTavilyUsable(resolved: {
  isOfficial: boolean
  apiKey: string | undefined
}): void {
  if (resolved.isOfficial && !resolved.apiKey) {
    throw new Error(
      'Tavily is not configured: set an API key (settings.tavilyApiKey or ' +
        'env TAVILY_API_KEY, used with the official https://api.tavily.com) ' +
        'or a custom endpoint (settings.tavilyEndpointUrl) via /web-tools, ' +
        'or choose a key-free backend (WEB_SEARCH_ADAPTER=bing for search, ' +
        'settings.webFetchAdapter="http" for fetch).',
    )
  }
}
