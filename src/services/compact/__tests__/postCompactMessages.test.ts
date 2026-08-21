import { describe, expect, test } from 'bun:test'
import type {
  Message,
  SystemCompactBoundaryMessage,
} from '../../../types/message.js'
import { buildPostCompactMessages, type CompactionResult } from '../compact.js'

function message(overrides: Partial<Message>): Message {
  return {
    type: 'system',
    uuid: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    ...overrides,
  } as Message
}

describe('buildPostCompactMessages', () => {
  test('attaches the post-compact estimate to the boundary for immediate UI refresh', () => {
    const boundary = message({
      subtype: 'compact_boundary',
      compactMetadata: { trigger: 'manual', preTokens: 72_000 },
    }) as SystemCompactBoundaryMessage
    const result: CompactionResult = {
      boundaryMarker: boundary,
      summaryMessages: [
        message({
          type: 'user',
        }) as CompactionResult['summaryMessages'][number],
      ],
      attachments: [],
      hookResults: [],
      truePostCompactTokenCount: 12_000,
    }

    const postCompactMessages = buildPostCompactMessages(result)
    const annotatedBoundary =
      postCompactMessages[0] as SystemCompactBoundaryMessage

    expect(annotatedBoundary.compactMetadata.estimatedPostCompactTokens).toBe(
      12_000,
    )
    expect(boundary.compactMetadata.estimatedPostCompactTokens).toBeUndefined()
  })
})
