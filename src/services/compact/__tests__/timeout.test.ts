import { describe, expect, test } from 'bun:test'
import {
  CompactForkTimeoutError,
  DEFAULT_COMPACT_FORK_TIMEOUT_MS,
  getCompactForkTimeoutMs,
  runCompactForkWithTimeout,
} from '../timeout.js'

describe('compact fork timeout', () => {
  test('returns a completed fork result', async () => {
    const parent = new AbortController()
    const result = await runCompactForkWithTimeout(
      parent,
      async () => 'summary',
      100,
    )
    expect(result).toBe('summary')
    expect(parent.signal.aborted).toBe(false)
  })

  test('times out only the fork controller', async () => {
    const parent = new AbortController()
    let forkSignal: AbortSignal | undefined

    await expect(
      runCompactForkWithTimeout(
        parent,
        async forkController => {
          forkSignal = forkController.signal
          return await new Promise<string>(() => {})
        },
        5,
      ),
    ).rejects.toBeInstanceOf(CompactForkTimeoutError)

    expect(forkSignal?.aborted).toBe(true)
    expect(parent.signal.aborted).toBe(false)
  })

  test('parent cancellation rejects when the operation does not settle', async () => {
    const parent = new AbortController()
    const pending = runCompactForkWithTimeout(
      parent,
      async () => await new Promise<string>(() => {}),
      10_000,
    )
    const reason = new Error('user interrupted')
    parent.abort(reason)
    await expect(pending).rejects.toBe(reason)
  })

  test('uses the default for invalid timeout values', () => {
    expect(getCompactForkTimeoutMs(undefined)).toBe(
      DEFAULT_COMPACT_FORK_TIMEOUT_MS,
    )
    expect(getCompactForkTimeoutMs('0')).toBe(DEFAULT_COMPACT_FORK_TIMEOUT_MS)
    expect(getCompactForkTimeoutMs('bad')).toBe(DEFAULT_COMPACT_FORK_TIMEOUT_MS)
  })
})
