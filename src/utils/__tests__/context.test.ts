import { afterEach, describe, expect, test } from 'bun:test'
import { getContextWindowForModel } from '../context.js'

const originalContextOverride = process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS
const originalUserType = process.env.USER_TYPE

afterEach(() => {
  if (originalContextOverride === undefined) {
    delete process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS
  } else {
    process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = originalContextOverride
  }

  if (originalUserType === undefined) {
    delete process.env.USER_TYPE
  } else {
    process.env.USER_TYPE = originalUserType
  }
})

describe('getContextWindowForModel', () => {
  test('honors the context override for non-ant local providers', () => {
    delete process.env.USER_TYPE
    process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = '160000'

    expect(getContextWindowForModel('/models')).toBe(160_000)
  })
})
