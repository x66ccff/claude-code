import OpenAI from 'openai'
import { getProxyFetchOptions } from 'src/utils/proxy.js'
import { wrapFetchForRawRequest } from '../rawRequestSnapshot.js'

/**
 * Environment variables:
 *
 * GROK_API_KEY (or XAI_API_KEY): Required. API key for the xAI Grok endpoint.
 * GROK_BASE_URL: Optional. Defaults to https://api.x.ai/v1.
 */

const DEFAULT_BASE_URL = 'https://api.x.ai/v1'

let cachedClient: OpenAI | null = null
let cachedRawCaptureClient: OpenAI | null = null

export function getGrokClient(options?: {
  fetchOverride?: typeof fetch
  source?: string
  captureRawRequest?: boolean
}): OpenAI {
  if (!options?.fetchOverride) {
    const cached = options?.captureRawRequest
      ? cachedRawCaptureClient
      : cachedClient
    if (cached) return cached
  }

  const apiKey = process.env.GROK_API_KEY || process.env.XAI_API_KEY || ''
  const baseURL = process.env.GROK_BASE_URL || DEFAULT_BASE_URL
  const baseFetch = options?.fetchOverride ?? (globalThis.fetch as typeof fetch)
  const requestFetch = options?.captureRawRequest
    ? wrapFetchForRawRequest(baseFetch, 'grok')
    : baseFetch

  const client = new OpenAI({
    apiKey,
    baseURL,
    // SDK retries stay disabled: the unified rate-limit policy
    // (rateLimitRetry.ts) owns the retry budget.
    maxRetries: 0,
    timeout: parseInt(process.env.API_TIMEOUT_MS || String(600 * 1000), 10),
    dangerouslyAllowBrowser: true,
    fetchOptions: getProxyFetchOptions({ forAnthropicAPI: false }),
    fetch: requestFetch,
  })

  if (!options?.fetchOverride) {
    if (options?.captureRawRequest) {
      cachedRawCaptureClient = client
    } else {
      cachedClient = client
    }
  }

  return client
}

export function clearGrokClientCache(): void {
  cachedClient = null
  cachedRawCaptureClient = null
}
