import { describe, expect, test } from 'bun:test'
import type { Message } from '../../types/message.js'
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
  }
}

describe('getContextMeterData', () => {
  test('uses the configured local context window and includes output tokens', () => {
    const previous = process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS
    process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = '131072'
    try {
      const data = getContextMeterData(
        [
          assistantMessage({
            input_tokens: 10_000,
            output_tokens: 1_000,
            cache_creation_input_tokens: 5_000,
            cache_read_input_tokens: 50_000,
          }),
        ],
        '/models',
      )

      expect(data.contextWindowSize).toBe(131_072)
      expect(data.usedTokens).toBe(66_000)
      expect(data.usedPercentage).toBe(50)
      expect(data.cacheHitRate).toBe(77)
      expect(data.usedTokensEstimated).toBe(false)
    } finally {
      if (previous === undefined) {
        delete process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS
      } else {
        process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = previous
      }
    }
  })

  test('shows placeholders before the first response', () => {
    const data = getContextMeterData([], 'claude-sonnet-4-6')
    expect(data.usedTokens).toBeNull()
    expect(data.usedPercentage).toBeNull()
    expect(data.cacheHitRate).toBeNull()
    expect(data.usedTokensEstimated).toBe(false)
  })

  test('uses the post-compact estimate instead of stale pre-compact usage', () => {
    const previous = process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS
    process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = '100000'
    try {
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
        '/models',
      )

      expect(data.usedTokens).toBe(12_000)
      expect(data.usedPercentage).toBe(12)
      expect(data.cacheHitRate).toBeNull()
      expect(data.usedTokensEstimated).toBe(true)
    } finally {
      if (previous === undefined) {
        delete process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS
      } else {
        process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = previous
      }
    }
  })
})
