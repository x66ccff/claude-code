import { afterEach, describe, expect, test } from 'bun:test'
import type { Question } from '@claude-code-best/builtin-tools/tools/AskUserQuestionTool/AskUserQuestionTool.js'
import {
  DEFAULT_ASK_USER_QUESTION_TIMEOUT_MS,
  buildAskUserQuestionTimeoutFeedback,
  getAskUserQuestionTimeoutMs,
} from '../askUserQuestionTimeout'

const ENV_KEY = 'CLAUDE_CODE_ASK_USER_QUESTION_TIMEOUT_MS'
const originalEnv = process.env[ENV_KEY]

afterEach(() => {
  if (originalEnv === undefined) {
    delete process.env[ENV_KEY]
  } else {
    process.env[ENV_KEY] = originalEnv
  }
})

describe('getAskUserQuestionTimeoutMs', () => {
  test('returns 10 minute default when env var is unset', () => {
    delete process.env[ENV_KEY]
    expect(DEFAULT_ASK_USER_QUESTION_TIMEOUT_MS).toBe(600_000)
    expect(getAskUserQuestionTimeoutMs()).toBe(
      DEFAULT_ASK_USER_QUESTION_TIMEOUT_MS,
    )
  })

  test('honors a valid env var override', () => {
    process.env[ENV_KEY] = '30000'
    expect(getAskUserQuestionTimeoutMs()).toBe(30_000)
  })

  test('treats 0 as disabled', () => {
    process.env[ENV_KEY] = '0'
    expect(getAskUserQuestionTimeoutMs()).toBe(0)
  })

  test('falls back to default on invalid values', () => {
    for (const invalid of ['abc', '-1000', 'NaN', '  ', 'Infinity']) {
      process.env[ENV_KEY] = invalid
      expect(getAskUserQuestionTimeoutMs()).toBe(
        DEFAULT_ASK_USER_QUESTION_TIMEOUT_MS,
      )
    }
  })
})

describe('buildAskUserQuestionTimeoutFeedback', () => {
  const questions: Question[] = [
    {
      question: 'Which library should we use?',
      header: 'Library',
      multiSelect: false,
      options: [
        {
          label: 'zod (Recommended)',
          description: 'Type-safe schema validation',
        },
        { label: 'yup', description: 'Alternative validator' },
      ],
    },
    {
      question: 'Which features do you want?',
      header: 'Features',
      multiSelect: true,
      options: [{ label: 'A' }, { label: 'B' }] as Question['options'],
    },
  ]

  test('mentions the timeout window in minutes', () => {
    const feedback = buildAskUserQuestionTimeoutFeedback(questions, 600_000)
    expect(feedback).toContain('did not respond within 10 minutes')
  })

  test('instructs the model to proceed on its own', () => {
    const feedback = buildAskUserQuestionTimeoutFeedback(questions, 600_000)
    expect(feedback).toContain('may be away from the computer')
    expect(feedback).toContain('Do NOT wait for a response')
    expect(feedback).toContain('(Recommended)')
    expect(feedback).toContain('use your own judgment')
  })

  test('includes every pending question with its options', () => {
    const feedback = buildAskUserQuestionTimeoutFeedback(questions, 600_000)
    expect(feedback).toContain('"Which library should we use?"')
    expect(feedback).toContain(
      '"zod (Recommended)" (Type-safe schema validation)',
    )
    expect(feedback).toContain('"Which features do you want?" [multi-select]')
  })

  test('clamps sub-minute timeouts to 1 minute in the message', () => {
    const feedback = buildAskUserQuestionTimeoutFeedback(questions, 5_000)
    expect(feedback).toContain('did not respond within 1 minutes')
  })
})
