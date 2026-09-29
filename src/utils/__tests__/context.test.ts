import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  getContextWindowForModel,
  MODEL_CONTEXT_WINDOW_DEFAULT,
} from '../context'

// A third-party model name (PAI qwen gateway) that matches none of the
// built-in 1M/chatgpt/capability branches, so it falls through to the
// 200k default unless an override or [1m] suffix applies.
const QWEN = 'qwen3.8-max'

const OVERRIDE = 'CLAUDE_CODE_MAX_CONTEXT_TOKENS'
const DISABLE_1M = 'CLAUDE_CODE_DISABLE_1M_CONTEXT'

let savedOverride: string | undefined
let savedDisable: string | undefined
let savedUserType: string | undefined

beforeEach(() => {
  savedOverride = process.env[OVERRIDE]
  savedDisable = process.env[DISABLE_1M]
  savedUserType = process.env.USER_TYPE
  delete process.env[OVERRIDE]
  delete process.env[DISABLE_1M]
  delete process.env.USER_TYPE
})

afterEach(() => {
  const restore = (key: string, value: string | undefined): void => {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  restore(OVERRIDE, savedOverride)
  restore(DISABLE_1M, savedDisable)
  restore('USER_TYPE', savedUserType)
})

describe('getContextWindowForModel — CLAUDE_CODE_MAX_CONTEXT_TOKENS switch', () => {
  test('defaults to 200k for a third-party model with no override', () => {
    expect(getContextWindowForModel(QWEN)).toBe(MODEL_CONTEXT_WINDOW_DEFAULT)
    expect(MODEL_CONTEXT_WINDOW_DEFAULT).toBe(200_000)
  })

  test('override to 1M applies for non-ant users (the 200k→1M switch)', () => {
    process.env[OVERRIDE] = '1000000'
    // USER_TYPE deliberately unset / external — override must still apply.
    expect(getContextWindowForModel(QWEN)).toBe(1_000_000)
  })

  test('override back to 200k applies for non-ant users', () => {
    process.env[OVERRIDE] = '200000'
    expect(getContextWindowForModel(QWEN)).toBe(200_000)
  })

  test('override accepts an arbitrary cap (e.g. provider real input limit)', () => {
    process.env[OVERRIDE] = '983616'
    expect(getContextWindowForModel(QWEN)).toBe(983_616)
  })

  test('invalid override values are ignored and fall through to default', () => {
    for (const bad of ['abc', '0', '-5', '']) {
      process.env[OVERRIDE] = bad
      expect(getContextWindowForModel(QWEN)).toBe(MODEL_CONTEXT_WINDOW_DEFAULT)
    }
  })

  test('override takes precedence over the [1m] suffix', () => {
    process.env[OVERRIDE] = '200000'
    expect(getContextWindowForModel(`${QWEN}[1m]`)).toBe(200_000)
  })
})

describe('getContextWindowForModel — [1m] suffix', () => {
  test('[1m] suffix opts into a 1M window for any model', () => {
    expect(getContextWindowForModel(`${QWEN}[1m]`)).toBe(1_000_000)
  })

  test('CLAUDE_CODE_DISABLE_1M_CONTEXT does not affect the explicit override', () => {
    process.env[DISABLE_1M] = '1'
    process.env[OVERRIDE] = '1000000'
    // The numeric override is independent of the 1M-detection kill switch.
    expect(getContextWindowForModel(QWEN)).toBe(1_000_000)
  })
})
