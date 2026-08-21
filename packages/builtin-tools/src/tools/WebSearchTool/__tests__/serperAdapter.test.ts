import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

const realErrors = await import('src/utils/errors.js')
const _abortMock = () => ({
  ...realErrors,
  AbortError: class AbortError extends Error {
    constructor(message?: string) {
      super(message)
      this.name = 'AbortError'
    }
  },
  isAbortError: (error: unknown) =>
    error instanceof Error && error.name === 'AbortError',
})
mock.module('src/utils/errors.js', _abortMock)
mock.module('src/utils/errors', _abortMock)

const originalApiKey = process.env.SERPER_API_KEY
const originalApiUrl = process.env.SERPER_API_URL

describe('SerperSearchAdapter.search', () => {
  const createAdapter = async () => {
    const { SerperSearchAdapter } = await import('../adapters/serperAdapter')
    return new SerperSearchAdapter()
  }

  const sampleResponse = {
    answerBox: {
      title: 'Direct answer',
      link: 'https://answer.example/page',
      snippet: 'Answer summary',
    },
    organic: [
      {
        title: 'Result One',
        link: 'https://example.com/result1',
        snippet: 'Snippet one',
      },
      {
        title: 'Result Two',
        link: 'https://docs.example.org/result2',
        snippet: 'Snippet two',
      },
    ],
  }

  beforeEach(() => {
    process.env.SERPER_API_KEY = 'test-serper-key'
    delete process.env.SERPER_API_URL
  })

  afterEach(() => {
    mock.restore()
    if (originalApiKey === undefined) {
      delete process.env.SERPER_API_KEY
    } else {
      process.env.SERPER_API_KEY = originalApiKey
    }
    if (originalApiUrl === undefined) {
      delete process.env.SERPER_API_URL
    } else {
      process.env.SERPER_API_URL = originalApiUrl
    }
  })

  test('posts to Serper and maps result links', async () => {
    const axiosPost = mock((_url: string, _data: unknown, _config: unknown) =>
      Promise.resolve({ data: sampleResponse }),
    )
    mock.module('axios', () => ({
      default: {
        post: axiosPost,
        isCancel: () => false,
        isAxiosError: () => false,
      },
    }))

    const results = await (await createAdapter()).search('current news', {
      numResults: 12,
    })

    expect(results).toHaveLength(3)
    expect(results[0]).toEqual({
      title: 'Direct answer',
      url: 'https://answer.example/page',
      snippet: 'Answer summary',
    })
    expect(axiosPost.mock.calls[0]?.[0]).toBe(
      'https://google.serper.dev/search',
    )
    expect(axiosPost.mock.calls[0]?.[1]).toEqual({
      q: 'current news',
      num: 12,
    })
    expect(axiosPost.mock.calls[0]?.[2]).toMatchObject({
      headers: { 'X-API-KEY': 'test-serper-key' },
    })
  })

  test('filters allowed and blocked domains including subdomains', async () => {
    mock.module('axios', () => ({
      default: {
        post: mock(() => Promise.resolve({ data: sampleResponse })),
        isCancel: () => false,
        isAxiosError: () => false,
      },
    }))

    const adapter = await createAdapter()
    const allowed = await adapter.search('test', {
      allowedDomains: ['example.org'],
    })
    const blocked = await adapter.search('test', {
      blockedDomains: ['example.com'],
    })

    expect(allowed.map(result => result.url)).toEqual([
      'https://docs.example.org/result2',
    ])
    expect(blocked.map(result => result.url)).toEqual([
      'https://answer.example/page',
      'https://docs.example.org/result2',
    ])
  })

  test('reports progress and clamps requested result count', async () => {
    const axiosPost = mock((_url: string, _data: unknown, _config: unknown) =>
      Promise.resolve({ data: sampleResponse }),
    )
    mock.module('axios', () => ({
      default: {
        post: axiosPost,
        isCancel: () => false,
        isAxiosError: () => false,
      },
    }))
    const progress: unknown[] = []

    await (await createAdapter()).search('test', {
      numResults: 1000,
      onProgress: update => progress.push(update),
    })

    expect(axiosPost.mock.calls[0]?.[1]).toEqual({ q: 'test', num: 100 })
    expect(progress).toEqual([
      { type: 'query_update', query: 'test' },
      {
        type: 'search_results_received',
        resultCount: 3,
        query: 'test',
      },
    ])
  })

  test('explains a missing API key', async () => {
    delete process.env.SERPER_API_KEY
    mock.module('axios', () => ({
      default: {
        post: mock(() => Promise.resolve({ data: sampleResponse })),
        isCancel: () => false,
        isAxiosError: () => false,
      },
    }))

    await expect((await createAdapter()).search('test', {})).rejects.toThrow(
      'Set SERPER_API_KEY',
    )
  })

  test.each([
    [401, 'Invalid API key', 'rejected the API key'],
    [402, 'No credits remaining', 'credits are exhausted'],
    [429, 'Too many requests', 'rate limit was reached'],
    [503, 'Service unavailable', 'temporarily unavailable'],
  ])('classifies HTTP %i failures', async (status, message, expected) => {
    const apiError = {
      isAxiosError: true,
      response: { status, data: { message } },
    }
    mock.module('axios', () => ({
      default: {
        post: mock(() => Promise.reject(apiError)),
        isCancel: () => false,
        isAxiosError: (error: unknown) =>
          typeof error === 'object' &&
          error !== null &&
          (error as { isAxiosError?: boolean }).isAxiosError === true,
      },
    }))

    await expect((await createAdapter()).search('test', {})).rejects.toThrow(
      expected,
    )
  })

  test('treats a quota message as exhausted even with HTTP 403', async () => {
    const apiError = {
      isAxiosError: true,
      response: { status: 403, data: { message: 'Account credits exhausted' } },
    }
    mock.module('axios', () => ({
      default: {
        post: mock(() => Promise.reject(apiError)),
        isCancel: () => false,
        isAxiosError: () => true,
      },
    }))

    await expect((await createAdapter()).search('test', {})).rejects.toThrow(
      'credits are exhausted',
    )
  })

  test('preserves cancellation as AbortError', async () => {
    mock.module('axios', () => ({
      default: {
        post: mock(() => Promise.resolve({ data: sampleResponse })),
        isCancel: () => false,
        isAxiosError: () => false,
      },
    }))
    const controller = new AbortController()
    controller.abort()

    const { AbortError } = await import('src/utils/errors')
    await expect(
      (await createAdapter()).search('test', { signal: controller.signal }),
    ).rejects.toThrow(AbortError)
  })
})
