import { sleep } from '../../utils/sleep.js'

export const RATE_LIMIT_MAX_ATTEMPTS = 10
export const RATE_LIMIT_BASE_DELAY_MS = 5_000

export type RateLimitKind =
  | 'http_429'
  | 'http_529'
  | 'anthropic_overloaded'
  | 'openai_rate_limit'
  | 'gemini_resource_exhausted'
  | 'bedrock_throttling'

export type RateLimitErrorInfo = {
  kind: RateLimitKind
  status?: number
  code?: string
}

export type RateLimitRetryState = {
  failures: number
}

export type RetrySleeper = (ms: number, signal?: AbortSignal) => Promise<void>

export class RateLimitError extends Error {
  readonly status?: number
  readonly code?: string
  readonly body?: unknown

  constructor(
    message: string,
    options: { status?: number; code?: string; body?: unknown } = {},
  ) {
    super(message)
    this.name = 'RateLimitError'
    this.status = options.status
    this.code = options.code
    this.body = options.body
  }
}

export class RateLimitRetryAbortError extends Error {
  constructor() {
    super('The operation was aborted')
    this.name = 'AbortError'
  }
}

const defaultSleeper: RetrySleeper = (ms, signal) =>
  sleep(ms, signal, { abortError: () => new RateLimitRetryAbortError() })

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined
}

function getNumber(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key]
  return typeof value === 'number' ? value : undefined
}

function getString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

function normalizedCode(value: string | undefined): string | undefined {
  return value
    ?.trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
}

function nestedRecords(error: unknown): Record<string, unknown>[] {
  const root = asRecord(error)
  if (!root) return []
  const records = [root]
  for (const key of ['error', 'cause', 'response', 'body', '$metadata']) {
    const nested = asRecord(root[key])
    if (nested) records.push(nested)
  }
  const response = asRecord(root.response)
  const responseData = asRecord(response?.data)
  if (responseData) records.push(responseData)
  const responseError = asRecord(responseData?.error)
  if (responseError) records.push(responseError)
  return records
}

export function getRateLimitErrorInfo(
  error: unknown,
): RateLimitErrorInfo | undefined {
  const records = nestedRecords(error)

  for (const record of records) {
    const status =
      getNumber(record, 'status') ??
      getNumber(record, 'statusCode') ??
      getNumber(record, 'httpStatusCode')
    if (status === 429 || status === 529) {
      return { kind: status === 429 ? 'http_429' : 'http_529', status }
    }
  }

  for (const record of records) {
    const code = normalizedCode(
      getString(record, 'code') ??
        getString(record, 'type') ??
        getString(record, 'status') ??
        getString(record, 'name'),
    )
    if (!code) continue
    if (code === 'overloaded_error') {
      return { kind: 'anthropic_overloaded', code }
    }
    if (
      code === 'rate_limit_exceeded' ||
      code === 'rate_limit_error' ||
      code === 'too_many_requests'
    ) {
      return { kind: 'openai_rate_limit', code }
    }
    if (code === 'resource_exhausted') {
      return { kind: 'gemini_resource_exhausted', code }
    }
    if (
      code === 'throttling' ||
      code === 'throttling_exception' ||
      code === 'throttlingexception' ||
      code === 'too_many_requests_exception' ||
      code === 'toomanyrequestsexception' ||
      code === 'request_limit_exceeded' ||
      code === 'requestlimitexceeded'
    ) {
      return { kind: 'bedrock_throttling', code }
    }
  }

  if (error instanceof Error) {
    if (error.message.includes('"type":"overloaded_error"')) {
      return { kind: 'anthropic_overloaded', code: 'overloaded_error' }
    }
    if (/\bRESOURCE_EXHAUSTED\b/.test(error.message)) {
      return {
        kind: 'gemini_resource_exhausted',
        code: 'resource_exhausted',
      }
    }
  }

  return undefined
}

// Errors marked here already produced user-visible output — replaying the
// request is forbidden, so retry layers must treat them as non-retryable.
const rateLimitNonRetryableErrors = new WeakSet<object>()

export function markRateLimitNonRetryable(error: unknown): void {
  if (typeof error === 'object' && error !== null) {
    rateLimitNonRetryableErrors.add(error)
  }
}

export function isRateLimitNonRetryable(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    rateLimitNonRetryableErrors.has(error)
  )
}

export function isRateLimitError(error: unknown): boolean {
  return getRateLimitErrorInfo(error) !== undefined
}

export function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true
  if (!(error instanceof Error)) return false
  return error.name === 'AbortError' || error.name === 'APIUserAbortError'
}

export function getRateLimitRetryDelayMs(failure: number): number {
  return failure * RATE_LIMIT_BASE_DELAY_MS
}

export async function waitForRateLimitRetry(
  error: unknown,
  state: RateLimitRetryState,
  options: {
    signal?: AbortSignal
    sleeper?: RetrySleeper
  } = {},
): Promise<boolean> {
  if (!isRateLimitError(error)) return false
  throwIfAborted(options.signal)

  state.failures++
  if (state.failures >= RATE_LIMIT_MAX_ATTEMPTS) throw error

  await (options.sleeper ?? defaultSleeper)(
    getRateLimitRetryDelayMs(state.failures),
    options.signal,
  )
  throwIfAborted(options.signal)
  return true
}

export async function retryRateLimit<T>(
  operation: (attempt: number) => Promise<T>,
  options: {
    signal?: AbortSignal
    sleeper?: RetrySleeper
  } = {},
): Promise<T> {
  const state: RateLimitRetryState = { failures: 0 }
  let attempt = 1
  while (true) {
    throwIfAborted(options.signal)
    try {
      return await operation(attempt)
    } catch (error) {
      if (isAbortError(error, options.signal)) throw error
      if (!(await waitForRateLimitRetry(error, state, options))) throw error
      attempt++
    }
  }
}

export async function* retryRateLimitStream<T>(
  createStream: (
    attempt: number,
  ) => AsyncIterable<T> | Promise<AsyncIterable<T>>,
  options: {
    hasOutput: (item: T) => boolean
    signal?: AbortSignal
    sleeper?: RetrySleeper
  },
): AsyncGenerator<T, void> {
  const state: RateLimitRetryState = { failures: 0 }
  let attempt = 1

  while (true) {
    throwIfAborted(options.signal)
    const buffered: T[] = []
    let emittedOutput = false
    try {
      const stream = await createStream(attempt)
      for await (const item of stream) {
        throwIfAborted(options.signal)
        if (!emittedOutput) {
          buffered.push(item)
          if (!options.hasOutput(item)) continue
          emittedOutput = true
          yield* buffered
          buffered.length = 0
        } else {
          yield item
        }
      }
      if (!emittedOutput) yield* buffered
      return
    } catch (error) {
      if (isAbortError(error, options.signal)) throw error
      if (emittedOutput || !isRateLimitError(error)) throw error
      await waitForRateLimitRetry(error, state, options)
      attempt++
    }
  }
}

export function isAnthropicStreamOutput(event: unknown): boolean {
  const record = asRecord(event)
  if (!record) return false
  if (record.type === 'content_block_start') {
    const block = asRecord(record.content_block)
    if (!block) return false
    if (block.type === 'tool_use' || block.type === 'server_tool_use')
      return true
    if (block.type === 'redacted_thinking') return true
    if (block.type === 'text') return Boolean(getString(block, 'text'))
    if (block.type === 'thinking') return Boolean(getString(block, 'thinking'))
    return false
  }
  if (record.type !== 'content_block_delta') return false
  const delta = asRecord(record.delta)
  if (!delta) return false
  if (delta.type === 'text_delta') return Boolean(getString(delta, 'text'))
  if (delta.type === 'thinking_delta')
    return Boolean(getString(delta, 'thinking'))
  if (delta.type === 'input_json_delta') {
    return Boolean(getString(delta, 'partial_json'))
  }
  return false
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new RateLimitRetryAbortError()
}
