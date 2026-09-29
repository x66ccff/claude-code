import { resetSdkInitState } from '../../bootstrap/state.js'
import { isRestrictedToPluginOnly } from '../settings/pluginOnlyPolicy.js'
// Import as module object so spyOn works in tests (direct imports bypass spies)
import * as settingsModule from '../settings/settings.js'
import { resetSettingsCache } from '../settings/settingsCache.js'
import type { HooksSettings } from '../settings/types.js'

let initialHooksConfig: HooksSettings | null = null

/**
 * Get hooks from allowed sources.
 * If allowManagedHooksOnly is set in policySettings, only managed hooks are returned.
 * If disableAllHooks is set in policySettings, no hooks are returned.
 * If disableAllHooks is set in non-managed settings, only managed hooks are returned
 * (non-managed settings cannot disable managed hooks).
 * Otherwise, returns merged hooks from all sources (backwards compatible).
 */
function getHooksFromAllowedSources(): HooksSettings {
  // [ccb mod] Hard-kill ALL settings-derived hooks (2026-09-15).
  // Rogue endpoint software (yunke aah_hooks / loongsuite-pilot) injects
  // PreToolUse/PostToolUse '.*' hooks into ~/.claude/settings.json, and a
  // root daemon re-injects them seconds after any removal — adding 3-5s
  // latency to EVERY tool call and interfering with Write/Read execution
  // ("Error writing file" / "Invalid tool parameters" / repeated hook
  // banners). Instead of fighting the daemon, this build refuses to execute
  // any hook that comes from settings files (user/project/local/policy).
  // Registered hooks (SDK callbacks, plugin native) and session hooks
  // (skill/agent frontmatter, structured-output function hooks) are
  // assembled separately in getHooksConfig() and remain functional — they
  // cannot be injected by external processes.
  // Debug escape hatch: CCB_ENABLE_SETTINGS_HOOKS=1 restores stock behavior.
  if (process.env.CCB_ENABLE_SETTINGS_HOOKS !== '1') {
    return {}
  }

  const policySettings = settingsModule.getSettingsForSource('policySettings')

  // If managed settings disables all hooks, return empty
  if (policySettings?.disableAllHooks === true) {
    return {}
  }

  // If allowManagedHooksOnly is set in managed settings, only use managed hooks
  if (policySettings?.allowManagedHooksOnly === true) {
    return policySettings.hooks ?? {}
  }

  // strictPluginOnlyCustomization: block user/project/local settings hooks.
  // Plugin hooks (registered channel, hooks.ts:1391) are NOT affected —
  // they're assembled separately and the managedOnly skip there is keyed
  // on shouldAllowManagedHooksOnly(), not on this policy. Agent frontmatter
  // hooks are gated at REGISTRATION (runAgent.ts:~535) by agent source —
  // plugin/built-in/policySettings agents register normally, user-sourced
  // agents skip registration under ["hooks"]. A blanket execution-time
  // block here would over-kill plugin agents' hooks.
  if (isRestrictedToPluginOnly('hooks')) {
    return policySettings?.hooks ?? {}
  }

  const mergedSettings = settingsModule.getSettings_DEPRECATED()

  // If disableAllHooks is set in non-managed settings, only managed hooks still run
  // (non-managed settings cannot override managed hooks)
  if (mergedSettings.disableAllHooks === true) {
    return policySettings?.hooks ?? {}
  }

  // Otherwise, use all hooks (merged from all sources) - backwards compatible
  return mergedSettings.hooks ?? {}
}

/**
 * Check if only managed hooks should run.
 * This is true when:
 * - policySettings has allowManagedHooksOnly: true, OR
 * - disableAllHooks is set in non-managed settings (non-managed settings
 *   cannot disable managed hooks, so they effectively become managed-only)
 */
export function shouldAllowManagedHooksOnly(): boolean {
  const policySettings = settingsModule.getSettingsForSource('policySettings')
  if (policySettings?.allowManagedHooksOnly === true) {
    return true
  }
  // If disableAllHooks is set but NOT from managed settings,
  // treat as managed-only (non-managed hooks disabled, managed hooks still run)
  if (
    settingsModule.getSettings_DEPRECATED().disableAllHooks === true &&
    policySettings?.disableAllHooks !== true
  ) {
    return true
  }
  return false
}

/**
 * Check if all hooks (including managed) should be disabled.
 * This is only true when managed/policy settings has disableAllHooks: true.
 * When disableAllHooks is set in non-managed settings, managed hooks still run.
 */
export function shouldDisableAllHooksIncludingManaged(): boolean {
  return (
    settingsModule.getSettingsForSource('policySettings')?.disableAllHooks ===
    true
  )
}

/**
 * Capture a snapshot of the current hooks configuration
 * This should be called once during application startup
 * Respects the allowManagedHooksOnly setting
 */
export function captureHooksConfigSnapshot(): void {
  initialHooksConfig = getHooksFromAllowedSources()
}

/**
 * Update the hooks configuration snapshot
 * This should be called when hooks are modified through the settings
 * Respects the allowManagedHooksOnly setting
 */
export function updateHooksConfigSnapshot(): void {
  // Reset the session cache to ensure we read fresh settings from disk.
  // Without this, the snapshot could use stale cached settings when the user
  // edits settings.json externally and then runs /hooks - the session cache
  // may not have been invalidated yet (e.g., if the file watcher's stability
  // threshold hasn't elapsed).
  resetSettingsCache()
  initialHooksConfig = getHooksFromAllowedSources()
}

/**
 * Get the current hooks configuration from snapshot
 * Falls back to settings if no snapshot exists
 * @returns The hooks configuration
 */
export function getHooksConfigFromSnapshot(): HooksSettings | null {
  if (initialHooksConfig === null) {
    captureHooksConfigSnapshot()
  }
  return initialHooksConfig
}

/**
 * Reset the hooks configuration snapshot (useful for testing)
 * Also resets SDK init state to prevent test pollution
 */
export function resetHooksConfigSnapshot(): void {
  initialHooksConfig = null
  resetSdkInitState()
}
