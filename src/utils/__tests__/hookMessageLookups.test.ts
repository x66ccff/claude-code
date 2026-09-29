import { describe, expect, test } from 'bun:test'
import type { HookProgress } from '../../types/hooks.js'
import { createAttachmentMessage } from '../attachments.js'
import {
  buildMessageLookups,
  createProgressMessage,
  hasUnresolvedHooksFromLookup,
  updateMessageLookupsIncremental,
} from '../messages.js'

function progress(hookId: string) {
  return createProgressMessage<HookProgress>({
    toolUseID: 'tool-1',
    parentToolUseID: 'tool-1',
    data: {
      type: 'hook_progress',
      hookId,
      hookEvent: 'PreToolUse',
      hookName: 'Bash',
      hookSource: 'settings',
      hookType: 'command',
      command: 'printf ok',
    },
  })
}

function completion(hookId: string) {
  return createAttachmentMessage({
    type: 'hook_execution',
    hookId,
    hookName: 'Bash',
    toolUseID: 'tool-1',
    hookEvent: 'PreToolUse',
    hookSource: 'settings',
    hookType: 'command',
    outcome: 'success',
    durationMs: 1,
  })
}

describe('Hook message lookups', () => {
  test('tracks concurrent completions by run ID', () => {
    const messages = [progress('run-1'), progress('run-2'), completion('run-1')]
    const lookups = buildMessageLookups(messages as any, messages as any)

    expect(lookups.inProgressHookCounts.get('tool-1')?.get('PreToolUse')).toBe(
      2,
    )
    expect(lookups.resolvedHookCounts.get('tool-1')?.get('PreToolUse')).toBe(1)
    expect(lookups.resolvedHookKeys.get('tool-1')?.get('PreToolUse')).toEqual(
      new Set(['run-1']),
    )
  })

  test('incremental updates deduplicate terminal records by run ID', () => {
    const initial = [progress('run-1')]
    const lookups = buildMessageLookups(initial as any, initial as any)
    const completed = [...initial, completion('run-1')]

    const firstUpdate = updateMessageLookupsIncremental(
      lookups,
      initial.length,
      initial.length,
      completed as any,
      completed as any,
    )
    expect(firstUpdate).toBe(lookups)
    expect(lookups.resolvedHookCounts.get('tool-1')?.get('PreToolUse')).toBe(1)

    const duplicated = [...completed, completion('run-1')]
    const secondUpdate = updateMessageLookupsIncremental(
      lookups,
      completed.length,
      completed.length,
      duplicated as any,
      duplicated as any,
    )
    expect(secondUpdate).toBe(lookups)
    expect(lookups.resolvedHookCounts.get('tool-1')?.get('PreToolUse')).toBe(1)
  })

  test('ignores unrelated terminal run IDs when checking unresolved Hooks', () => {
    const messages = [progress('run-1'), completion('rejected-1')]
    const lookups = buildMessageLookups(messages as any, messages as any)

    expect(hasUnresolvedHooksFromLookup('tool-1', 'PreToolUse', lookups)).toBe(
      true,
    )
  })
})
