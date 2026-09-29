import { describe, expect, test } from 'bun:test'
import type { Message } from '../../types/message.js'
import { splitUsedTokensIntoSegments } from '../../utils/contextEstimation.js'
import { getContextMeterData } from '../ContextUsageBar.js'

function assistantMessage(usage: {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
}): Message {
  return {
    type: 'assistant',
    uuid: '00000000-0000-0000-0000-000000000000',
    timestamp: new Date().toISOString(),
    message: {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: 'test-model',
      content: [{ type: 'text', text: 'done' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        ...usage,
        server_tool_use: {
          web_search_requests: 0,
          web_fetch_requests: 0,
        },
        service_tier: null,
        cache_creation: {
          ephemeral_1h_input_tokens: 0,
          ephemeral_5m_input_tokens: 0,
        },
      },
    },
  } as Message
}

// CLAUDE_CODE_MAX_CONTEXT_TOKENS override in getContextWindowForModel applies
// for all users (no longer ant-gated) — set it so the env override applies
// deterministically regardless of the host model mapping. USER_TYPE is pinned
// to 'ant' only to neutralize any ant-specific model resolution downstream.
function withContextWindowOverride(tokens: string, fn: () => void): void {
  const previousTokens = process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS
  const previousUserType = process.env.USER_TYPE
  process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = tokens
  process.env.USER_TYPE = 'ant'
  try {
    fn()
  } finally {
    if (previousTokens === undefined) {
      delete process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS
    } else {
      process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = previousTokens
    }
    if (previousUserType === undefined) {
      delete process.env.USER_TYPE
    } else {
      process.env.USER_TYPE = previousUserType
    }
  }
}

describe('getContextMeterData', () => {
  test('uses the configured local context window and includes output tokens', () => {
    withContextWindowOverride('131072', () => {
      const data = getContextMeterData(
        [
          assistantMessage({
            input_tokens: 10_000,
            output_tokens: 1_000,
            cache_creation_input_tokens: 5_000,
            cache_read_input_tokens: 50_000,
          }),
        ],
        'test-model',
      )

      expect(data.contextWindowSize).toBe(131_072)
      expect(data.usedTokens).toBe(66_000)
      expect(data.usedPercentage).toBe(50)
      expect(data.cacheHitRate).toBe(77)
      expect(data.usedTokensEstimated).toBe(false)
    })
  })

  test('shows placeholders before the first response', () => {
    const data = getContextMeterData([], 'claude-sonnet-4-6')
    expect(data.usedTokens).toBeNull()
    expect(data.usedPercentage).toBeNull()
    expect(data.cacheHitRate).toBeNull()
    expect(data.usedTokensEstimated).toBe(false)
  })

  test('uses the post-compact estimate instead of stale pre-compact usage', () => {
    withContextWindowOverride('100000', () => {
      const data = getContextMeterData(
        [
          assistantMessage({
            input_tokens: 70_000,
            output_tokens: 2_000,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          }),
          {
            type: 'system',
            subtype: 'compact_boundary',
            uuid: '00000000-0000-0000-0000-000000000001',
            timestamp: new Date().toISOString(),
            compactMetadata: { estimatedPostCompactTokens: 12_000 },
          } as Message,
        ],
        'test-model',
      )

      expect(data.usedTokens).toBe(12_000)
      expect(data.usedPercentage).toBe(12)
      expect(data.cacheHitRate).toBeNull()
      expect(data.usedTokensEstimated).toBe(true)
    })
  })
})

describe('splitUsedTokensIntoSegments', () => {
  test('messages get the remainder above the estimated overhead', () => {
    const split = splitUsedTokensIntoSegments(50_000, {
      systemTokens: 10_000,
      toolsTokens: 15_000,
      memoryTokens: 5_000,
    })
    expect(split.systemTokens).toBe(10_000)
    expect(split.toolsTokens).toBe(15_000)
    expect(split.memoryTokens).toBe(5_000)
    expect(split.messagesTokens).toBe(20_000)
  })

  test('scales overhead down proportionally when estimate overshoots usage', () => {
    const split = splitUsedTokensIntoSegments(10_000, {
      systemTokens: 20_000,
      toolsTokens: 10_000,
      memoryTokens: 10_000,
    })
    expect(split.messagesTokens).toBe(0)
    expect(Math.round(split.systemTokens)).toBe(5_000)
    expect(Math.round(split.toolsTokens)).toBe(2_500)
    expect(Math.round(split.memoryTokens)).toBe(2_500)
  })

  test('zero estimate puts everything into messages', () => {
    const split = splitUsedTokensIntoSegments(42_000, {
      systemTokens: 0,
      toolsTokens: 0,
      memoryTokens: 0,
    })
    expect(split.messagesTokens).toBe(42_000)
    expect(split.systemTokens).toBe(0)
  })

  test('negative usage clamps messages to zero', () => {
    const split = splitUsedTokensIntoSegments(-5, {
      systemTokens: 0,
      toolsTokens: 0,
      memoryTokens: 0,
    })
    expect(split.messagesTokens).toBe(0)
  })
})
