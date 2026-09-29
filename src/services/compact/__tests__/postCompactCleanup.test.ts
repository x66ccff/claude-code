import { afterEach, describe, expect, mock, test } from 'bun:test'
import { logMock } from '../../../../tests/mocks/log.js'

const getUserContext = Object.assign(() => ({}), {
  cache: { clear: () => {} },
})

mock.module('bun:bundle', () => ({ feature: () => false }))
mock.module('src/constants/systemPromptSections.ts', () => ({
  clearSystemPromptSections: () => {},
}))
mock.module('src/context.ts', () => ({ getUserContext }))
mock.module(
  '@claude-code-best/builtin-tools/tools/BashTool/bashPermissions.js',
  () => ({ clearSpeculativeChecks: () => {} }),
)
mock.module('src/utils/classifierApprovals.ts', () => ({
  clearClassifierApprovals: () => {},
}))
mock.module('src/utils/claudemd.ts', () => ({
  resetGetMemoryFilesCache: () => {},
}))
mock.module('src/utils/log.ts', logMock)
mock.module('src/utils/sessionStorage.ts', () => ({
  clearSessionMessagesCache: () => {},
}))
mock.module('src/utils/telemetry/betaSessionTracing.ts', () => ({
  clearBetaTracingState: () => {},
}))
mock.module('src/services/compact/microCompact.ts', () => ({
  resetMicrocompactState: () => {},
}))

const { registerCompactCleanup, runPostCompactCleanup } = await import(
  '../postCompactCleanup.js'
)

const unregisterCallbacks: Array<() => void> = []

afterEach(() => {
  for (const unregister of unregisterCallbacks.splice(0)) {
    unregister()
  }
})

describe('compact cleanup callbacks', () => {
  test('runs registered callbacks for every main-thread source', () => {
    let calls = 0
    unregisterCallbacks.push(registerCompactCleanup(() => calls++))

    runPostCompactCleanup()
    runPostCompactCleanup('sdk')
    runPostCompactCleanup('repl_main_thread:compact')

    expect(calls).toBe(3)
  })

  test('does not run callbacks after unregistering', () => {
    let calls = 0
    const unregister = registerCompactCleanup(() => calls++)

    unregister()
    runPostCompactCleanup('repl_main_thread')

    expect(calls).toBe(0)
  })

  test('does not run main-thread callbacks for subagent compaction', () => {
    let calls = 0
    unregisterCallbacks.push(registerCompactCleanup(() => calls++))

    runPostCompactCleanup('agent:explore')

    expect(calls).toBe(0)
  })
})
