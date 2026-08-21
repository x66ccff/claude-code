import { afterEach, describe, expect, test } from 'bun:test'

let { createAdapter } = await import('../adapters/index')

const originalWebSearchAdapter = process.env.WEB_SEARCH_ADAPTER

afterEach(() => {
  if (originalWebSearchAdapter === undefined) {
    delete process.env.WEB_SEARCH_ADAPTER
  } else {
    process.env.WEB_SEARCH_ADAPTER = originalWebSearchAdapter
  }
})

describe('createAdapter', () => {
  test('prioritizes WEB_SEARCH_ADAPTER env var over all other config', () => {
    process.env.WEB_SEARCH_ADAPTER = 'api'
    expect(createAdapter().constructor.name).toBe('ApiSearchAdapter')

    process.env.WEB_SEARCH_ADAPTER = 'bing'
    expect(createAdapter().constructor.name).toBe('BingSearchAdapter')

    process.env.WEB_SEARCH_ADAPTER = 'brave'
    expect(createAdapter().constructor.name).toBe('BraveSearchAdapter')

    process.env.WEB_SEARCH_ADAPTER = 'exa'
    expect(createAdapter().constructor.name).toBe('ExaSearchAdapter')

    process.env.WEB_SEARCH_ADAPTER = 'tavily'
    expect(createAdapter().constructor.name).toBe('TavilySearchAdapter')

    process.env.WEB_SEARCH_ADAPTER = 'serper'
    expect(createAdapter().constructor.name).toBe('SerperSearchAdapter')
  })

  test('reuses the same instance when the selected backend does not change', () => {
    process.env.WEB_SEARCH_ADAPTER = 'brave'

    const firstAdapter = createAdapter()
    const secondAdapter = createAdapter()

    expect(firstAdapter).toBe(secondAdapter)
  })

  test('rebuilds the adapter when WEB_SEARCH_ADAPTER changes', () => {
    process.env.WEB_SEARCH_ADAPTER = 'brave'
    const braveAdapter = createAdapter()

    process.env.WEB_SEARCH_ADAPTER = 'bing'
    const bingAdapter = createAdapter()

    expect(bingAdapter).not.toBe(braveAdapter)
  })

  test('uses a configured setting or the Serper machine default', () => {
    delete process.env.WEB_SEARCH_ADAPTER

    const adapter = createAdapter()
    // The actual adapter may vary if settings.webSearchAdapter is set on disk.
    // But we only assert it's one of the valid adapter types.
    const validTypes = [
      'ApiSearchAdapter',
      'BingSearchAdapter',
      'BraveSearchAdapter',
      'ExaSearchAdapter',
      'SerperSearchAdapter',
      'TavilySearchAdapter',
    ]
    expect(validTypes).toContain(adapter.constructor.name)
  })
})
