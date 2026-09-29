/**
 * Derive a one-line "latest activity" snapshot from an assistant message's
 * content blocks. Feeds the workflow panel's per-agent marquee (ThinkingMarquee)
 * so a stalled agent is visible at a glance: the ticker tail-pins the most
 * recent thinking/text/tool call, and the store's lastActivityAt lets the
 * panel flag agents that stopped producing content.
 *
 * Pure module (no Ink / no engine imports) so it is cheap to unit test.
 */

type ContentBlock = Record<string, unknown>

/** Max chars of a tool-call input preview (the marquee itself truncates further by terminal width). */
const TOOL_INPUT_PREVIEW = 120

/**
 * Walk the content blocks in order and keep the LAST interesting one:
 * - thinking  -> `thinking: <text>` (trimmed)
 * - text      -> `<text>` (trimmed; raw assistant prose)
 * - tool_use  -> `⚙ <name> <json preview>`
 * Returns undefined when no block carries visible content.
 */
export function describeAssistantActivity(
  content: ContentBlock[] | undefined,
): string | undefined {
  if (!content) return undefined
  let latest: string | undefined
  for (const b of content) {
    if (
      b.type === 'thinking' &&
      typeof b.thinking === 'string' &&
      b.thinking.trim()
    ) {
      latest = `thinking: ${b.thinking.trim()}`
    } else if (
      b.type === 'text' &&
      typeof b.text === 'string' &&
      b.text.trim()
    ) {
      latest = b.text.trim()
    } else if (b.type === 'tool_use' && typeof b.name === 'string') {
      const raw =
        typeof b.input === 'string' ? b.input : JSON.stringify(b.input ?? {})
      const preview =
        raw.length > TOOL_INPUT_PREVIEW
          ? `${raw.slice(0, TOOL_INPUT_PREVIEW)}…`
          : raw
      latest = `⚙ ${b.name} ${preview}`
    }
  }
  return latest
}
