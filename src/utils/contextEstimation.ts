// CONTEXT_USAGE_BAR: zero-API local rough estimation of the fixed context
// overhead segments (system prompt / tool schemas / memory files) for the
// always-on colored usage bar.
//
// Why this exists: /context (analyzeContextUsage) is exact but fires 30-60+
// real countTokens API calls — far too heavy for a bar that renders on every
// prompt repaint. Here every segment is estimated locally with
// roughTokenCountEstimation (chars/4, same helper analyzeContext already uses
// for its non-API fallbacks) and the whole computation runs AT MOST ONCE per
// session (module-level cache + inflight dedup). Results are rough by design:
// the bar renders them as proportional color segments next to the exact
// usage-based percentage, which remains the source of truth.
import type { AgentDefinition } from '@claude-code-best/builtin-tools/tools/AgentTool/loadAgentsDir.js'
import {
  getSystemPrompt,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
} from 'src/constants/prompts.js'
import { roughTokenCountEstimation } from '../services/tokenEstimation.js'
import type { ToolPermissionContext, Tools } from '../Tool.js'
import { toolToAPISchema } from './api.js'
import { filterInjectedMemoryFiles, getMemoryFiles } from './claudemd.js'
import { getSystemContext } from '../context.js'
import { jsonStringify } from './slowOperations.js'

export type ContextSegmentEstimate = {
  systemTokens: number
  toolsTokens: number
  memoryTokens: number
}

let cachedEstimate: ContextSegmentEstimate | null = null
let inflight: Promise<ContextSegmentEstimate> | null = null

/** Synchronous read of the session cache (null until the first compute resolves). */
export function getCachedContextSegmentEstimate(): ContextSegmentEstimate | null {
  return cachedEstimate
}

/**
 * Compute (once per session) the rough token sizes of the fixed overhead
 * segments. Safe to call from a component effect: dedups concurrent calls,
 * never throws (errors yield zeros and allow a later retry), makes no API
 * calls. toolToAPISchema reuses the session-level tool schema cache, so the
 * prompt() serialization cost is paid once and shared with real requests.
 */
export function estimateContextSegmentsOnce(opts: {
  tools: Tools
  model: string
  getToolPermissionContext: () => Promise<ToolPermissionContext>
  agents: AgentDefinition[]
}): Promise<ContextSegmentEstimate> {
  if (cachedEstimate) return Promise.resolve(cachedEstimate)
  if (inflight) return inflight
  inflight = (async (): Promise<ContextSegmentEstimate> => {
    try {
      const [promptParts, systemContext, memoryFiles, toolSchemas] =
        await Promise.all([
          getSystemPrompt(opts.tools, opts.model),
          getSystemContext(),
          filterInjectedMemoryFiles(await getMemoryFiles()),
          Promise.all(
            opts.tools.map(tool =>
              toolToAPISchema(tool, {
                getToolPermissionContext: opts.getToolPermissionContext,
                tools: opts.tools,
                agents: opts.agents,
                model: opts.model,
              }),
            ),
          ),
        ])

      let systemTokens = 0
      for (const part of promptParts) {
        if (part.length > 0 && part !== SYSTEM_PROMPT_DYNAMIC_BOUNDARY) {
          systemTokens += roughTokenCountEstimation(part)
        }
      }
      for (const value of Object.values(systemContext)) {
        if (typeof value === 'string' && value.length > 0) {
          systemTokens += roughTokenCountEstimation(value)
        }
      }

      let memoryTokens = 0
      for (const file of memoryFiles) {
        memoryTokens += roughTokenCountEstimation(file.content)
      }

      let toolsTokens = 0
      for (const schema of toolSchemas) {
        toolsTokens += roughTokenCountEstimation(jsonStringify(schema))
      }

      cachedEstimate = { systemTokens, toolsTokens, memoryTokens }
      return cachedEstimate
    } catch {
      // Don't cache failures — a later mount can retry. Report zeros so the
      // bar falls back to its single-color rendering in the meantime.
      inflight = null
      return { systemTokens: 0, toolsTokens: 0, memoryTokens: 0 }
    }
  })()
  return inflight
}

/** Test/reset hook. */
export function resetContextSegmentEstimateCache(): void {
  cachedEstimate = null
  inflight = null
}

/**
 * Split `usedTokens` (exact, from the last API usage) into display segments:
 * the three estimated overhead categories plus the remainder as messages.
 * When the rough overhead estimate overshoots the exact used total, the
 * overhead segments are scaled down proportionally and messages get 0 —
 * the bar never shows more than the real usage.
 */
export function splitUsedTokensIntoSegments(
  usedTokens: number,
  estimate: ContextSegmentEstimate,
): {
  systemTokens: number
  toolsTokens: number
  memoryTokens: number
  messagesTokens: number
} {
  const overhead =
    estimate.systemTokens + estimate.toolsTokens + estimate.memoryTokens
  if (overhead <= 0) {
    return {
      systemTokens: 0,
      toolsTokens: 0,
      memoryTokens: 0,
      messagesTokens: Math.max(0, usedTokens),
    }
  }
  if (overhead > usedTokens) {
    const scale = usedTokens / overhead
    return {
      systemTokens: estimate.systemTokens * scale,
      toolsTokens: estimate.toolsTokens * scale,
      memoryTokens: estimate.memoryTokens * scale,
      messagesTokens: 0,
    }
  }
  return {
    systemTokens: estimate.systemTokens,
    toolsTokens: estimate.toolsTokens,
    memoryTokens: estimate.memoryTokens,
    messagesTokens: usedTokens - overhead,
  }
}
