import { describe, expect, test } from 'bun:test'
import { shouldShowQuerySpinner } from '../replSpinner.js'

const active = {
  toolJSXAllowsSpinner: true,
  hasToolUseConfirm: false,
  hasPrompt: false,
  hasActiveWork: true,
  pendingWorkerApproval: false,
  onlySleepToolActive: false,
}

describe('REPL query spinner', () => {
  test('stays visible while answer text streams during an active query', () => {
    expect(shouldShowQuerySpinner(active)).toBe(true)
  })

  test('stays visible while tool input streams during an active query', () => {
    expect(shouldShowQuerySpinner(active)).toBe(true)
  })

  test('stops when query work finishes', () => {
    expect(shouldShowQuerySpinner({ ...active, hasActiveWork: false })).toBe(
      false,
    )
  })

  test('stays hidden behind permission and prompt dialogs', () => {
    expect(shouldShowQuerySpinner({ ...active, hasToolUseConfirm: true })).toBe(
      false,
    )
    expect(shouldShowQuerySpinner({ ...active, hasPrompt: true })).toBe(false)
    expect(
      shouldShowQuerySpinner({ ...active, pendingWorkerApproval: true }),
    ).toBe(false)
  })

  test('stays hidden for Sleep-only tool execution and explicit JSX suppression', () => {
    expect(
      shouldShowQuerySpinner({ ...active, onlySleepToolActive: true }),
    ).toBe(false)
    expect(
      shouldShowQuerySpinner({ ...active, toolJSXAllowsSpinner: false }),
    ).toBe(false)
  })
})
