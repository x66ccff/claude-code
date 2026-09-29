import { afterEach, describe, expect, test } from 'bun:test'
import {
  clearHookEventState,
  emitHookProgress,
  emitHookResponse,
  emitHookStarted,
  registerHookEventHandler,
  setAllHookEventsEnabled,
  type HookExecutionEvent,
} from '../hookEvents.js'

afterEach(() => {
  clearHookEventState()
})

describe('hook event metadata', () => {
  test('propagates source, type, input, and duration through the lifecycle', () => {
    const events: HookExecutionEvent[] = []
    setAllHookEventsEnabled(true)
    registerHookEventHandler(event => events.push(event))

    emitHookStarted('run-1', 'Bash', 'PreToolUse', {
      hookSource: 'plugin:example',
      hookType: 'command',
      displayInput: 'printf ok',
    })
    emitHookProgress({
      hookId: 'run-1',
      hookName: 'Bash',
      hookEvent: 'PreToolUse',
      stdout: 'working',
      stderr: '',
      output: 'working',
    })
    emitHookResponse({
      hookId: 'run-1',
      hookName: 'Bash',
      hookEvent: 'PreToolUse',
      output: 'ok',
      stdout: 'ok',
      stderr: '',
      exitCode: 0,
      outcome: 'success',
    })

    expect(events).toHaveLength(3)
    for (const event of events) {
      expect(event.hookSource).toBe('plugin:example')
      expect(event.hookType).toBe('command')
      expect(event.displayInput).toBe('printf ok')
    }
    expect(events[2]?.type).toBe('response')
    if (events[2]?.type === 'response') {
      expect(events[2].durationMs).toBeGreaterThanOrEqual(0)
    }
  })

  test('cleans metadata when output is disabled before response', () => {
    const events: HookExecutionEvent[] = []
    setAllHookEventsEnabled(true)
    registerHookEventHandler(event => events.push(event))
    emitHookStarted('run-1', 'Bash', 'PreToolUse', {
      hookSource: 'stale-source',
    })

    setAllHookEventsEnabled(false)
    emitHookResponse({
      hookId: 'run-1',
      hookName: 'Bash',
      hookEvent: 'PreToolUse',
      output: '',
      stdout: '',
      stderr: '',
      outcome: 'success',
    })

    setAllHookEventsEnabled(true)
    emitHookProgress({
      hookId: 'run-1',
      hookName: 'Bash',
      hookEvent: 'PreToolUse',
      stdout: 'later',
      stderr: '',
      output: 'later',
    })

    const progress = events.at(-1)
    expect(progress?.type).toBe('progress')
    if (progress?.type === 'progress') {
      expect(progress.hookSource).toBeUndefined()
    }
  })

  test('clearHookEventState removes per-run metadata', () => {
    emitHookStarted('run-1', 'startup', 'SessionStart', {
      hookSource: 'stale-source',
    })
    clearHookEventState()

    const events: HookExecutionEvent[] = []
    registerHookEventHandler(event => events.push(event))
    emitHookProgress({
      hookId: 'run-1',
      hookName: 'startup',
      hookEvent: 'SessionStart',
      stdout: 'later',
      stderr: '',
      output: 'later',
    })

    expect(events).toHaveLength(1)
    const progress = events[0]
    expect(progress?.type).toBe('progress')
    if (progress?.type === 'progress') {
      expect(progress.hookSource).toBeUndefined()
    }
  })
})
