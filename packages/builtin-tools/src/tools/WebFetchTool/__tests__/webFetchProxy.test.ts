import { afterEach, describe, expect, test } from 'bun:test'
import {
  normalizeWebFetchProxyError,
  resetWebFetchProxyClient,
  resolveWebFetchProxySettings,
  WebFetchProxyError,
} from '../webFetchProxy.js'

afterEach(() => {
  resetWebFetchProxyClient()
})

describe('resolveWebFetchProxySettings', () => {
  test('defaults to direct access without machine-specific configuration', () => {
    const settings = resolveWebFetchProxySettings({})

    expect(settings).toMatchObject({
      proxyUrl: undefined,
      source: 'direct',
    })
    expect(settings.noProxy.split(',')).toEqual(
      expect.arrayContaining(['localhost', '127.0.0.1', '::1']),
    )
  })

  test('supports an explicit direct mode', () => {
    expect(
      resolveWebFetchProxySettings({
        CLAUDE_CODE_WEB_FETCH_PROXY: 'direct',
      }),
    ).toMatchObject({ proxyUrl: undefined, source: 'direct' })
  })

  test('supports a custom proxy without exposing it globally', () => {
    expect(
      resolveWebFetchProxySettings({
        CLAUDE_CODE_WEB_FETCH_PROXY: 'http://127.0.0.1:9999',
      }),
    ).toMatchObject({
      proxyUrl: 'http://127.0.0.1:9999/',
      source: 'custom',
    })
  })

  test('can inherit the ordinary HTTPS proxy on request', () => {
    expect(
      resolveWebFetchProxySettings({
        CLAUDE_CODE_WEB_FETCH_PROXY: 'inherit',
        HTTPS_PROXY: 'http://proxy.example:8080',
      }),
    ).toMatchObject({
      proxyUrl: 'http://proxy.example:8080',
      source: 'inherit',
    })
  })

  test('merges custom bypasses and known LAN addresses', () => {
    const settings = resolveWebFetchProxySettings({
      CLAUDE_CODE_WEB_FETCH_NO_PROXY: 'example.com,.internal.test',
      LAN_IP_THIS_MACHINE: '192.168.50.216',
    })

    expect(settings.noProxy.split(',')).toEqual(
      expect.arrayContaining([
        'example.com',
        '.internal.test',
        '192.168.50.216',
      ]),
    )
  })

  test('rejects unsupported proxy protocols with guidance', () => {
    expect(() =>
      resolveWebFetchProxySettings({
        CLAUDE_CODE_WEB_FETCH_PROXY: 'socks5://127.0.0.1:7121',
      }),
    ).toThrow('must use http:// or https://')
  })
})

describe('normalizeWebFetchProxyError', () => {
  test('turns a proxy transport failure into an actionable error', () => {
    const previous = process.env.CLAUDE_CODE_WEB_FETCH_PROXY
    process.env.CLAUDE_CODE_WEB_FETCH_PROXY = 'http://127.0.0.1:9999'
    try {
      const normalized = normalizeWebFetchProxyError({
        isAxiosError: true,
        code: 'ECONNREFUSED',
        message: 'connect refused',
      })

      expect(normalized).toBeInstanceOf(WebFetchProxyError)
      expect((normalized as Error).message).toContain('127.0.0.1:9999')
      expect((normalized as Error).message).toContain('configured proxy')
    } finally {
      if (previous === undefined) {
        delete process.env.CLAUDE_CODE_WEB_FETCH_PROXY
      } else {
        process.env.CLAUDE_CODE_WEB_FETCH_PROXY = previous
      }
    }
  })

  test('preserves HTTP response errors', () => {
    const error = {
      isAxiosError: true,
      response: { status: 404 },
    }
    expect(normalizeWebFetchProxyError(error)).toBe(error)
  })
})
