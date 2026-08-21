import { isEnvDefinedFalsy } from '../../utils/envUtils.js'

export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 90_000

/** The watchdog is enabled unless the caller explicitly opts out. */
export function isStreamWatchdogEnabled(
  value: string | boolean | undefined = process.env
    .CLAUDE_ENABLE_STREAM_WATCHDOG,
): boolean {
  return !isEnvDefinedFalsy(value)
}

export function getStreamIdleTimeoutMs(
  value: string | undefined = process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS,
): number {
  if (value === undefined) return DEFAULT_STREAM_IDLE_TIMEOUT_MS

  const parsed = Number.parseInt(value, 10)
  return Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_STREAM_IDLE_TIMEOUT_MS
}
