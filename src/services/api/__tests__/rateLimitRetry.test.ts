/**
 * Unit tests for the unified rate-limit retry utility.
 *
 * Covers error recognition across all provider shapes, the fixed linear
 * backoff (exactly 10 failed attempts, delays 5s..45s), Retry-After being
 * ignored, non-limit passthrough, abort behavior, and the streaming wrapper's
 * no-replay boundary (retry before visible output, never after).
 *
 * All waits are injected via a mock sleeper — no real time passes.
 */
import { describe, expect, test } from 'bun:test'
import {
  RATE_LIMIT_BASE_DELAY_MS,
  RATE_LIMIT_MAX_ATTEMPTS,
  RateLimitError,
  type RetrySleeper,
  getRateLimitErrorInfo,
  getRateLimitRetryDelayMs,
  isAbortError,
  isAnthropicStreamOutput,
  isRateLimitError,
  isRateLimitNonRetryable,
  markRateLimitNonRetryable,
  retryRateLimit,
  retryRateLimitStream,
  waitForRateLimitRetry,
} from '../rateLimitRetry.js'

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeSleeper(): { delays: number[]; sleeper: RetrySleeper } {
  const delays: number[] = []
  const sleeper: RetrySleeper = async ms => {
    delays.push(ms)
  }
  return { delays, sleeper }
}

function rateLimit429(): Error {
  return Object.assign(new Error('429 Too many concurrent requests'), {
    status: 429,
  })
}

async function* streamFrom(
  items: unknown[],
  thenThrow?: unknown,
): AsyncGenerator<unknown, void> {
  for (const it of items) yield it
  if (thenThrow) throw thenThrow
}

async function collect(gen: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = []
  for await (const ev of gen) out.push(ev)
  return out
}

// ─── error recognition ───────────────────────────────────────────────────────

describe('getRateLimitErrorInfo — recognized shapes', () => {
  test('HTTP 429 via status', () => {
    expect(getRateLimitErrorInfo({ status: 429 })?.kind).toBe('http_429')
  })

  test('HTTP 529 via status', () => {
    expect(getRateLimitErrorInfo({ status: 529 })?.kind).toBe('http_529')
  })

  test('HTTP 429 via statusCode', () => {
    expect(getRateLimitErrorInfo({ statusCode: 429 })?.kind).toBe('http_429')
  })

  test('Bedrock 429 via $metadata.httpStatusCode', () => {
    expect(
      getRateLimitErrorInfo({ $metadata: { httpStatusCode: 429 } })?.kind,
    ).toBe('http_429')
  })

  test('Anthropic overloaded_error via nested error.type', () => {
    expect(
      getRateLimitErrorInfo({ error: { type: 'overloaded_error' } })?.kind,
    ).toBe('anthropic_overloaded')
  })

  test('OpenAI rate_limit_exceeded code', () => {
    expect(getRateLimitErrorInfo({ code: 'rate_limit_exceeded' })?.kind).toBe(
      'openai_rate_limit',
    )
  })

  test('OpenAI too_many_requests code (normalized case/dash)', () => {
    expect(getRateLimitErrorInfo({ code: 'Too-Many-Requests' })?.kind).toBe(
      'openai_rate_limit',
    )
  })

  test('Gemini RESOURCE_EXHAUSTED via error.status string', () => {
    expect(
      getRateLimitErrorInfo({ error: { status: 'RESOURCE_EXHAUSTED' } })?.kind,
    ).toBe('gemini_resource_exhausted')
  })

  test('Bedrock ThrottlingException via name', () => {
    expect(getRateLimitErrorInfo({ name: 'ThrottlingException' })?.kind).toBe(
      'bedrock_throttling',
    )
  })

  test('RateLimitError instance carries status', () => {
    const info = getRateLimitErrorInfo(
      new RateLimitError('limited', { status: 429 }),
    )
    expect(info?.kind).toBe('http_429')
    expect(info?.status).toBe(429)
  })

  test('Anthropic overloaded detected from raw message text', () => {
    const err = new Error('stream error: {"type":"overloaded_error"}')
    expect(getRateLimitErrorInfo(err)?.kind).toBe('anthropic_overloaded')
  })

  test('Gemini RESOURCE_EXHAUSTED detected from message text', () => {
    const err = new Error('RESOURCE_EXHAUSTED: quota exceeded')
    expect(getRateLimitErrorInfo(err)?.kind).toBe('gemini_resource_exhausted')
  })

  test('deeply nested response.data.error.code', () => {
    const err = {
      response: { data: { error: { code: 'rate_limit_exceeded' } } },
    }
    expect(getRateLimitErrorInfo(err)?.kind).toBe('openai_rate_limit')
  })
})

describe('getRateLimitErrorInfo — non-limit shapes', () => {
  test('400 is not a rate limit', () => {
    expect(getRateLimitErrorInfo({ status: 400 })).toBeUndefined()
  })

  test('500 is not a rate limit', () => {
    expect(getRateLimitErrorInfo({ status: 500 })).toBeUndefined()
  })

  test('plain error message is not a rate limit', () => {
    expect(getRateLimitErrorInfo(new Error('connection reset'))).toBeUndefined()
  })

  test('invalid_request_error code is not a rate limit', () => {
    expect(
      getRateLimitErrorInfo({ code: 'invalid_request_error' }),
    ).toBeUndefined()
  })

  test('isRateLimitError mirrors getRateLimitErrorInfo', () => {
    expect(isRateLimitError({ status: 429 })).toBe(true)
    expect(isRateLimitError({ status: 404 })).toBe(false)
  })
})

// ─── delay schedule ──────────────────────────────────────────────────────────

describe('getRateLimitRetryDelayMs', () => {
  test('linear schedule N * 5000ms', () => {
    expect(getRateLimitRetryDelayMs(1)).toBe(RATE_LIMIT_BASE_DELAY_MS)
    expect(getRateLimitRetryDelayMs(9)).toBe(45_000)
  })

  test('constants match the fixed contract', () => {
    expect(RATE_LIMIT_MAX_ATTEMPTS).toBe(10)
    expect(RATE_LIMIT_BASE_DELAY_MS).toBe(5_000)
  })
})

// ─── retryRateLimit (promise) ────────────────────────────────────────────────

describe('retryRateLimit', () => {
  test('exactly 10 failed attempts, delays 5s..45s, then throws', async () => {
    const { delays, sleeper } = makeSleeper()
    let calls = 0
    await expect(
      retryRateLimit(
        async () => {
          calls++
          throw rateLimit429()
        },
        { sleeper },
      ),
    ).rejects.toBeInstanceOf(Error)
    expect(calls).toBe(10)
    expect(delays).toEqual([
      5_000, 10_000, 15_000, 20_000, 25_000, 30_000, 35_000, 40_000, 45_000,
    ])
  })

  test('short-circuits on success after two failures', async () => {
    const { delays, sleeper } = makeSleeper()
    let calls = 0
    const result = await retryRateLimit(
      async () => {
        calls++
        if (calls < 3) throw rateLimit429()
        return 'ok'
      },
      { sleeper },
    )
    expect(result).toBe('ok')
    expect(calls).toBe(3)
    expect(delays).toEqual([5_000, 10_000])
  })

  test('ignores Retry-After and uses the fixed linear delay', async () => {
    const { delays, sleeper } = makeSleeper()
    let calls = 0
    await retryRateLimit(
      async () => {
        calls++
        if (calls === 1) {
          throw Object.assign(new Error('429'), {
            status: 429,
            headers: { 'retry-after': '120' },
          })
        }
        return 'done'
      },
      { sleeper },
    )
    expect(delays).toEqual([5_000])
  })

  test('non-rate-limit errors pass through without retry', async () => {
    const { delays, sleeper } = makeSleeper()
    let calls = 0
    const err = Object.assign(new Error('bad request'), { status: 400 })
    await expect(
      retryRateLimit(
        async () => {
          calls++
          throw err
        },
        { sleeper },
      ),
    ).rejects.toBe(err)
    expect(calls).toBe(1)
    expect(delays).toEqual([])
  })

  test('pre-aborted signal throws before any attempt', async () => {
    const { delays, sleeper } = makeSleeper()
    const controller = new AbortController()
    controller.abort()
    let calls = 0
    await expect(
      retryRateLimit(
        async () => {
          calls++
          return 'never'
        },
        { sleeper, signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(calls).toBe(0)
    expect(delays).toEqual([])
  })

  test('abort during the wait stops retrying', async () => {
    const controller = new AbortController()
    const sleeper: RetrySleeper = async () => {
      controller.abort()
    }
    let calls = 0
    await expect(
      retryRateLimit(
        async () => {
          calls++
          throw rateLimit429()
        },
        { sleeper, signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(calls).toBe(1)
  })
})

// ─── waitForRateLimitRetry (low level) ───────────────────────────────────────

describe('waitForRateLimitRetry', () => {
  test('returns false and does not count non-rate-limit errors', async () => {
    const { delays, sleeper } = makeSleeper()
    const state = { failures: 0 }
    const handled = await waitForRateLimitRetry({ status: 400 }, state, {
      sleeper,
    })
    expect(handled).toBe(false)
    expect(state.failures).toBe(0)
    expect(delays).toEqual([])
  })

  test('increments failures and sleeps the linear delay', async () => {
    const { delays, sleeper } = makeSleeper()
    const state = { failures: 0 }
    const handled = await waitForRateLimitRetry(rateLimit429(), state, {
      sleeper,
    })
    expect(handled).toBe(true)
    expect(state.failures).toBe(1)
    expect(delays).toEqual([5_000])
  })

  test('throws the original error on the 10th failure', async () => {
    const { sleeper } = makeSleeper()
    const state = { failures: 9 }
    const err = rateLimit429()
    await expect(waitForRateLimitRetry(err, state, { sleeper })).rejects.toBe(
      err,
    )
    expect(state.failures).toBe(10)
  })
})

// ─── isAbortError ────────────────────────────────────────────────────────────

describe('isAbortError', () => {
  test('detects APIUserAbortError by name', () => {
    const err = Object.assign(new Error('aborted'), {
      name: 'APIUserAbortError',
    })
    expect(isAbortError(err)).toBe(true)
  })

  test('detects AbortError by name', () => {
    expect(
      isAbortError(Object.assign(new Error('x'), { name: 'AbortError' })),
    ).toBe(true)
  })

  test('aborted signal counts regardless of error', () => {
    const controller = new AbortController()
    controller.abort()
    expect(isAbortError(new Error('anything'), controller.signal)).toBe(true)
  })

  test('non-abort error without signal is false', () => {
    expect(isAbortError({ status: 429 })).toBe(false)
  })
})

// ─── retryRateLimitStream (no-replay boundary) ───────────────────────────────

describe('retryRateLimitStream', () => {
  const successEvents = [
    { type: 'message_start' },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'hi' },
    },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    { type: 'message_stop' },
  ]

  test('retries the whole stream when it fails before visible output', async () => {
    const { delays, sleeper } = makeSleeper()
    let attempts = 0
    const gen = retryRateLimitStream(
      async () => {
        attempts++
        if (attempts === 1) throw rateLimit429()
        return streamFrom(successEvents)
      },
      { hasOutput: isAnthropicStreamOutput, sleeper },
    )
    const collected = await collect(gen)
    expect(attempts).toBe(2)
    expect(delays).toEqual([5_000])
    expect(collected).toEqual(successEvents)
  })

  test('discards a failed attempt metadata, no duplicate message_start', async () => {
    const { sleeper } = makeSleeper()
    let attempts = 0
    const gen = retryRateLimitStream(
      async () => {
        attempts++
        if (attempts === 1) {
          return streamFrom(
            [{ type: 'message_start' }, { type: 'ping' }],
            rateLimit429(),
          )
        }
        return streamFrom(successEvents)
      },
      { hasOutput: isAnthropicStreamOutput, sleeper },
    )
    const collected = await collect(gen)
    expect(attempts).toBe(2)
    const starts = collected.filter(
      e => (e as { type?: string }).type === 'message_start',
    )
    expect(starts).toHaveLength(1)
  })

  test('does not retry once visible output has been emitted', async () => {
    const { sleeper } = makeSleeper()
    let attempts = 0
    const preOutput = [
      { type: 'message_start' },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'hi' },
      },
    ]
    const gen = retryRateLimitStream(
      async () => {
        attempts++
        return streamFrom(preOutput, rateLimit429())
      },
      { hasOutput: isAnthropicStreamOutput, sleeper },
    )
    const collected: unknown[] = []
    await expect(
      (async () => {
        for await (const ev of gen) collected.push(ev)
      })(),
    ).rejects.toMatchObject({ status: 429 })
    expect(attempts).toBe(1)
    expect(collected).toEqual(preOutput)
  })

  test('tool_use content_block_start counts as visible output', async () => {
    const { sleeper } = makeSleeper()
    let attempts = 0
    const gen = retryRateLimitStream(
      async () => {
        attempts++
        return streamFrom(
          [
            { type: 'message_start' },
            {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'tool_use', id: 't', name: 'bash' },
            },
          ],
          rateLimit429(),
        )
      },
      { hasOutput: isAnthropicStreamOutput, sleeper },
    )
    await expect(collect(gen)).rejects.toMatchObject({ status: 429 })
    expect(attempts).toBe(1)
  })
})

// ─── isAnthropicStreamOutput ─────────────────────────────────────────────────

describe('isAnthropicStreamOutput', () => {
  test('tool_use / server_tool_use / redacted_thinking starts are output', () => {
    expect(
      isAnthropicStreamOutput({
        type: 'content_block_start',
        content_block: { type: 'tool_use' },
      }),
    ).toBe(true)
    expect(
      isAnthropicStreamOutput({
        type: 'content_block_start',
        content_block: { type: 'server_tool_use' },
      }),
    ).toBe(true)
    expect(
      isAnthropicStreamOutput({
        type: 'content_block_start',
        content_block: { type: 'redacted_thinking' },
      }),
    ).toBe(true)
  })

  test('empty text/thinking starts are not output', () => {
    expect(
      isAnthropicStreamOutput({
        type: 'content_block_start',
        content_block: { type: 'text', text: '' },
      }),
    ).toBe(false)
    expect(
      isAnthropicStreamOutput({
        type: 'content_block_start',
        content_block: { type: 'thinking', thinking: '' },
      }),
    ).toBe(false)
  })

  test('non-empty text/thinking starts are output', () => {
    expect(
      isAnthropicStreamOutput({
        type: 'content_block_start',
        content_block: { type: 'text', text: 'hi' },
      }),
    ).toBe(true)
  })

  test('text/thinking/input_json deltas with content are output', () => {
    expect(
      isAnthropicStreamOutput({
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'x' },
      }),
    ).toBe(true)
    expect(
      isAnthropicStreamOutput({
        type: 'content_block_delta',
        delta: { type: 'thinking_delta', thinking: 'x' },
      }),
    ).toBe(true)
    expect(
      isAnthropicStreamOutput({
        type: 'content_block_delta',
        delta: { type: 'input_json_delta', partial_json: '{"a"' },
      }),
    ).toBe(true)
  })

  test('empty deltas and signature deltas are not output', () => {
    expect(
      isAnthropicStreamOutput({
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: '' },
      }),
    ).toBe(false)
    expect(
      isAnthropicStreamOutput({
        type: 'content_block_delta',
        delta: { type: 'signature_delta', signature: 'sig' },
      }),
    ).toBe(false)
  })

  test('message_start / content_block_stop / non-objects are not output', () => {
    expect(isAnthropicStreamOutput({ type: 'message_start' })).toBe(false)
    expect(isAnthropicStreamOutput({ type: 'content_block_stop' })).toBe(false)
    expect(isAnthropicStreamOutput(null)).toBe(false)
    expect(isAnthropicStreamOutput('text')).toBe(false)
  })
})

// ─── non-retryable marker ────────────────────────────────────────────────────

describe('markRateLimitNonRetryable', () => {
  test('marks an error as non-retryable', () => {
    const err = rateLimit429()
    expect(isRateLimitNonRetryable(err)).toBe(false)
    markRateLimitNonRetryable(err)
    expect(isRateLimitNonRetryable(err)).toBe(true)
  })

  test('ignores non-object values without throwing', () => {
    expect(() => markRateLimitNonRetryable('nope')).not.toThrow()
    expect(isRateLimitNonRetryable('nope')).toBe(false)
    expect(isRateLimitNonRetryable(null)).toBe(false)
  })
})
