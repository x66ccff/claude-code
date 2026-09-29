/**
 * Tests for initialPermissionModeFromCLI() — the startup permission-mode
 * resolution in permissionSetup.ts.
 *
 * Focus: the POWER_USER fallback (default → bypassPermissions) and its
 * interaction with the bypass-disable gates and explicit CLI/settings modes.
 *
 * NOTE: feature() is folded by Bun's transpiler at module load, so
 * mock.module('bun:bundle') cannot toggle it. Run this file twice to cover
 * both flag states:
 *   bun test src/utils/permissions/__tests__/initialPermissionModeFromCLI.test.ts
 *   bun test --feature POWER_USER src/utils/permissions/__tests__/initialPermissionModeFromCLI.test.ts
 * Expectations branch on feature('POWER_USER') so both runs must pass.
 */
import { feature } from 'bun:bundle'
import { describe, expect, mock, test } from 'bun:test'
import { debugMock } from '../../../../tests/mocks/debug'
import { logMock } from '../../../../tests/mocks/log'

// ── controllable mocks ───────────────────────────────────────────────────────

mock.module('src/utils/log.ts', logMock)
mock.module('src/utils/debug.ts', debugMock)

// Spread the real growthbook module (analytics are empty stubs) so
// transitive importers keep all exports; override only the gate check.
let statsigDisableBypass = false
const realGrowthbook = await import('src/services/analytics/growthbook.js')
mock.module('src/services/analytics/growthbook.js', () => ({
  ...realGrowthbook,
  checkStatsigFeatureGate_CACHED_MAY_BE_STALE: () => statsigDisableBypass,
}))

mock.module('src/services/analytics/index.js', () => ({
  logEvent: () => {},
}))

// Pre-import the real settings module so transitive importers keep all its
// exports (mock.module is global); only override getSettings_DEPRECATED.
let settingsOverride: Record<string, unknown> = {}
const realSettings = await import('src/utils/settings/settings.js')
mock.module('src/utils/settings/settings.js', () => ({
  ...realSettings,
  getSettings_DEPRECATED: () => settingsOverride,
}))

// tools.js pulls in the whole builtin-tools registry — not needed here.
mock.module('src/tools.js', () => ({
  TOOL_PRESETS: ['default'],
  ALL_AGENT_DISALLOWED_TOOLS: [],
  CUSTOM_AGENT_DISALLOWED_TOOLS: [],
  ASYNC_AGENT_ALLOWED_TOOLS: [],
  COORDINATOR_MODE_ALLOWED_TOOLS: [],
  REPL_ONLY_TOOLS: [],
  getToolsForDefaultPreset: () => [],
  parseToolPreset: () => null,
  getAllBaseTools: () => [],
  filterToolsByDenyRules: (tools: unknown[]) => tools,
  getTools: () => [],
  assembleToolPool: () => [],
  getMergedTools: () => [],
}))

const { initialPermissionModeFromCLI } = await import('../permissionSetup.js')

// ── tests ────────────────────────────────────────────────────────────────────

describe('initialPermissionModeFromCLI', () => {
  test('final fallback honors POWER_USER (bypassPermissions) and defaults otherwise', () => {
    settingsOverride = {}
    const result = initialPermissionModeFromCLI({
      permissionModeCli: undefined,
      dangerouslySkipPermissions: undefined,
    })
    expect(result.mode).toBe(
      feature('POWER_USER') ? 'bypassPermissions' : 'default',
    )
  })

  test('explicit --permission-mode still takes priority under POWER_USER', () => {
    settingsOverride = {}
    const result = initialPermissionModeFromCLI({
      permissionModeCli: 'plan',
      dangerouslySkipPermissions: undefined,
    })
    expect(result.mode).toBe('plan')
  })

  test('settings.permissions.defaultMode still takes priority under POWER_USER', () => {
    settingsOverride = { permissions: { defaultMode: 'acceptEdits' } }
    const result = initialPermissionModeFromCLI({
      permissionModeCli: undefined,
      dangerouslySkipPermissions: undefined,
    })
    expect(result.mode).toBe('acceptEdits')
  })

  test('--dangerously-skip-permissions resolves to bypassPermissions', () => {
    settingsOverride = {}
    const result = initialPermissionModeFromCLI({
      permissionModeCli: undefined,
      dangerouslySkipPermissions: true,
    })
    expect(result.mode).toBe('bypassPermissions')
  })

  test('Statsig disable gate forces default fallback even under POWER_USER', () => {
    settingsOverride = {}
    statsigDisableBypass = true
    try {
      // Explicit bypass request is gated out, and the POWER_USER fallback
      // must also degrade to 'default' while the gate is active.
      const result = initialPermissionModeFromCLI({
        permissionModeCli: undefined,
        dangerouslySkipPermissions: true,
      })
      expect(result.mode).toBe('default')
      expect(result.notification).toBe(
        'Bypass permissions mode was disabled by your organization policy',
      )
    } finally {
      statsigDisableBypass = false
    }
  })

  test('settings disableBypassPermissionsMode forces default fallback even under POWER_USER', () => {
    settingsOverride = {
      permissions: { disableBypassPermissionsMode: 'disable' },
    }
    const result = initialPermissionModeFromCLI({
      permissionModeCli: undefined,
      dangerouslySkipPermissions: true,
    })
    expect(result.mode).toBe('default')
  })
})
