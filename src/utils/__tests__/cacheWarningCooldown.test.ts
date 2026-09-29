import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  setSystemTime,
  test,
} from 'bun:test'

// settings/settings.js is a documented must-mock (side-effectful chain via
// config/bootstrap). shouldShowCacheWarning never calls it, but the module
// import does.
mock.module('src/utils/settings/settings.js', () => ({
  getInitialSettings: () => ({}),
}))

const { shouldShowCacheWarning, _resetCacheWarningStateForTest } = await import(
  '../cacheWarning.js'
)

// hitRate = read / (input + creation + read). Keep creation non-zero even at
// 0% so calculateCacheHitRate doesn't treat the response as "no cache data".
function usageWith(
  hitPct: number,
  total = 10_000,
): {
  input_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
} {
  const read = Math.round((total * hitPct) / 100)
  return {
    input_tokens: 0,
    cache_creation_input_tokens: total - read,
    cache_read_input_tokens: read,
  }
}

const THRESHOLD = 70

beforeEach(() => {
  _resetCacheWarningStateForTest()
  setSystemTime(new Date('2026-09-16T12:00:00Z'))
})

afterEach(() => {
  setSystemTime()
})

describe('shouldShowCacheWarning — injection cooldown', () => {
  test('first low-hit response does not warn (baseline), second does', () => {
    // First call only records the baseline.
    expect(shouldShowCacheWarning(usageWith(90), 'main', THRESHOLD)).toBeNull()
    const info = shouldShowCacheWarning(usageWith(0), 'main', THRESHOLD)
    expect(info?.shouldWarn).toBe(true)
  })

  test('repeated low-hit responses within the cooldown window warn only once', () => {
    shouldShowCacheWarning(usageWith(90), 'main', THRESHOLD)
    expect(
      shouldShowCacheWarning(usageWith(0), 'main', THRESHOLD),
    ).not.toBeNull()
    // Simulate a long turn: 20 more API round-trips at 0% within 5 minutes.
    for (let i = 1; i <= 20; i++) {
      setSystemTime(
        new Date(new Date('2026-09-16T12:00:00Z').getTime() + i * 10_000),
      )
      expect(shouldShowCacheWarning(usageWith(0), 'main', THRESHOLD)).toBeNull()
    }
  })

  test('warns again after the cooldown window elapses', () => {
    shouldShowCacheWarning(usageWith(90), 'main', THRESHOLD)
    expect(
      shouldShowCacheWarning(usageWith(0), 'main', THRESHOLD),
    ).not.toBeNull()
    setSystemTime(new Date('2026-09-16T12:06:00Z'))
    const info = shouldShowCacheWarning(usageWith(0), 'main', THRESHOLD)
    expect(info?.shouldWarn).toBe(true)
  })

  test('materially worsened hit rate bypasses the cooldown', () => {
    shouldShowCacheWarning(usageWith(90), 'main', THRESHOLD)
    // First warn at 50%.
    expect(
      shouldShowCacheWarning(usageWith(50), 'main', THRESHOLD),
    ).not.toBeNull()
    // Still in cooldown, but dropped to 30% (>= 10pp worse) → warns again.
    setSystemTime(new Date('2026-09-16T12:01:00Z'))
    const info = shouldShowCacheWarning(usageWith(30), 'main', THRESHOLD)
    expect(info?.shouldWarn).toBe(true)
    // A non-worsened 35% right after stays silenced.
    setSystemTime(new Date('2026-09-16T12:02:00Z'))
    expect(shouldShowCacheWarning(usageWith(35), 'main', THRESHOLD)).toBeNull()
  })

  test('cooldown is tracked per querySource independently', () => {
    shouldShowCacheWarning(usageWith(90), 'main', THRESHOLD)
    expect(
      shouldShowCacheWarning(usageWith(0), 'main', THRESHOLD),
    ).not.toBeNull()
    // Different source: its own cooldown state is independent of main's —
    // first call records the baseline, second call warns.
    shouldShowCacheWarning(usageWith(90), 'subagent-1', THRESHOLD)
    expect(
      shouldShowCacheWarning(usageWith(0), 'subagent-1', THRESHOLD),
    ).not.toBeNull()
    // Its immediate repeat IS suppressed by its own cooldown.
    expect(
      shouldShowCacheWarning(usageWith(0), 'subagent-1', THRESHOLD),
    ).toBeNull()
  })

  test('healthy hit rate never warns regardless of cooldown state', () => {
    shouldShowCacheWarning(usageWith(90), 'main', THRESHOLD)
    setSystemTime(new Date('2026-09-16T13:00:00Z'))
    expect(shouldShowCacheWarning(usageWith(95), 'main', THRESHOLD)).toBeNull()
  })
})
