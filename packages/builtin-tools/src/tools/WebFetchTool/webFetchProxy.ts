import axios, { type AxiosInstance } from 'axios'
import {
  createAxiosInstanceForProxy,
  getNoProxy,
  getProxyUrl,
} from 'src/utils/proxy.js'

const DIRECT_VALUES = new Set(['direct', 'none', 'off', 'false', '0'])

type EnvLike = Record<string, string | undefined>

export interface WebFetchProxySettings {
  proxyUrl: string | undefined
  noProxy: string
  source: 'custom' | 'inherit' | 'direct'
}

export class WebFetchProxyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WebFetchProxyError'
  }
}

let cachedClient:
  | {
      key: string
      client: AxiosInstance
    }
  | undefined

/**
 * Resolve the proxy used only by Claude Code's native WebFetch tool.
 *
 * - unset: connect directly
 * - direct/off/none/false/0: explicitly bypass a proxy
 * - inherit: use HTTPS_PROXY/HTTP_PROXY
 * - URL: use that HTTP(S) proxy
 */
export function resolveWebFetchProxySettings(
  env: EnvLike = process.env,
): WebFetchProxySettings {
  const configured = env.CLAUDE_CODE_WEB_FETCH_PROXY?.trim()
  let proxyUrl: string | undefined
  let source: WebFetchProxySettings['source']

  if (configured && DIRECT_VALUES.has(configured.toLowerCase())) {
    proxyUrl = undefined
    source = 'direct'
  } else if (configured?.toLowerCase() === 'inherit') {
    proxyUrl = getProxyUrl(env)
    source = 'inherit'
  } else if (configured) {
    proxyUrl = validateProxyUrl(configured)
    source = 'custom'
  } else {
    proxyUrl = undefined
    source = 'direct'
  }

  const noProxy = mergeNoProxyEntries(
    env.CLAUDE_CODE_WEB_FETCH_NO_PROXY ?? getNoProxy(env),
    env.LAN_IP_THIS_MACHINE,
    env.LAN_IP_WINDOWS_DESKTOP,
    env.LAN_IP_PHONE,
  )

  return { proxyUrl, noProxy, source }
}

export function getWebFetchHttpClient(): AxiosInstance {
  const settings = resolveWebFetchProxySettings()
  const key = `${settings.proxyUrl ?? '<direct>'}|${settings.noProxy}`

  if (cachedClient?.key === key) {
    return cachedClient.client
  }

  const client = createAxiosInstanceForProxy(
    settings.proxyUrl,
    settings.noProxy,
  )
  cachedClient = { key, client }
  return client
}

/** Convert a transport failure into an actionable WebFetch-specific error. */
export function normalizeWebFetchProxyError(error: unknown): unknown {
  if (error instanceof WebFetchProxyError) {
    return error
  }

  const settings = resolveWebFetchProxySettings()
  if (!settings.proxyUrl || !isAxiosLikeError(error) || error.response) {
    return error
  }

  const code = error.code ? `, ${error.code}` : ''
  return new WebFetchProxyError(
    `WebFetch could not complete through the configured proxy ${formatProxyForDisplay(settings.proxyUrl)}${code}. ` +
      'Check that the HTTP proxy is running, or set CLAUDE_CODE_WEB_FETCH_PROXY=direct to bypass it.',
  )
}

function isAxiosLikeError(error: unknown): error is {
  code?: string
  response?: unknown
} {
  return (
    axios.isAxiosError(error) ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { isAxiosError?: boolean }).isAxiosError === true)
  )
}

export function resetWebFetchProxyClient(): void {
  cachedClient = undefined
}

function validateProxyUrl(value: string): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new WebFetchProxyError(
      'CLAUDE_CODE_WEB_FETCH_PROXY must be an HTTP(S) proxy URL, "inherit", or "direct".',
    )
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new WebFetchProxyError(
      'CLAUDE_CODE_WEB_FETCH_PROXY must use http:// or https://.',
    )
  }
  return parsed.toString()
}

function mergeNoProxyEntries(
  configured: string | undefined,
  ...lanAddresses: Array<string | undefined>
): string {
  const entries = new Set(['localhost', '127.0.0.1', '::1'])
  for (const entry of configured?.split(/[,\s]+/) ?? []) {
    if (entry.trim()) entries.add(entry.trim())
  }
  for (const address of lanAddresses) {
    if (address?.trim()) entries.add(address.trim())
  }
  return Array.from(entries).join(',')
}

function formatProxyForDisplay(proxyUrl: string): string {
  try {
    const parsed = new URL(proxyUrl)
    parsed.username = ''
    parsed.password = ''
    return parsed.toString().replace(/\/$/, '')
  } catch {
    return '<configured proxy>'
  }
}
