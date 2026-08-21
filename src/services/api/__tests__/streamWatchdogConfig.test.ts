import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  getStreamIdleTimeoutMs,
  isStreamWatchdogEnabled,
} from '../streamWatchdogConfig.js'

describe('stream watchdog configuration', () => {
  test('is enabled by default and can be explicitly disabled', () => {
    expect(isStreamWatchdogEnabled(undefined)).toBe(true)
    expect(isStreamWatchdogEnabled('0')).toBe(false)
    expect(isStreamWatchdogEnabled('false')).toBe(false)
    expect(isStreamWatchdogEnabled('1')).toBe(true)
  })

  test('accepts a positive timeout and rejects invalid values', () => {
    expect(getStreamIdleTimeoutMs('180000')).toBe(180_000)
    expect(getStreamIdleTimeoutMs('0')).toBe(DEFAULT_STREAM_IDLE_TIMEOUT_MS)
    expect(getStreamIdleTimeoutMs('-1')).toBe(DEFAULT_STREAM_IDLE_TIMEOUT_MS)
    expect(getStreamIdleTimeoutMs('invalid')).toBe(
      DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    )
  })
})
