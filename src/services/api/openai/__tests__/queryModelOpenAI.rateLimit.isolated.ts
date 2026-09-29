/**
 * Integration-style tests for the rate-limit retry wiring around the OpenAI
 * stream adapter in index.ts.
 *
 * Covers the three behaviors the unified retry policy requires:
 *  1. A 429 thrown at create-time (before any visible output) is retried — the
 *     whole create+adapt pipeline re-runs and the successful attempt's events
 *     are emitted with no lingering API-error message.
 *  2. A 429 thrown AFTER visible output has streamed is NOT retried; it
 *     propagates and surfaces as a single api_error assistant message.
 *  3. A user abort never becomes an "API Error" assistant message.
 *
 * All network + timing is mocked: create() is a stub, the stream adapter yields
 * pre-built Anthropic events, and sleep() resolves immediately so retries never
 * wait. This file is `.isolated.ts` (not auto-run by `bun test`) because the
 * module mocks would otherwise leak into other specs in the same process.
 */
import { describe, expect, test, mock, beforeEach } from 'bun:test'
import type { BetaRawMessageStreamEvent } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type {
  AssistantMessage,
  StreamEvent,
} from '../../../../types/message.js'

// ─── event helpers ───────────────────────────────────────────────────────────

function makeMessageStart(): BetaRawMessageStreamEvent {
  return {
    type: 'message_start',
    message: {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      content: [],
      model: 'test-model',
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  } as any
}

function makeContentBlockStart(
  index: number,
  type: 'text' | 'tool_use' | 'thinking',
): BetaRawMessageStreamEvent {
  const block =
    type === 'text'
      ? { type: 'text', text: '' }
      : type === 'tool_use'
        ? { type: 'tool_use', id: 'toolu_test', name: 'bash', input: {} }
        : { type: 'thinking', thinking: '', signature: '' }
  return { type: 'content_block_start', index, content_block: block } as any
}

function makeTextDelta(index: number, text: string): BetaRawMessageStreamEvent {
  return {
    type: 'content_block_delta',
    index,
    delta: { type: 'text_delta', text },
  } as any
}

function makeContentBlockStop(index: number): BetaRawMessageStreamEvent {
  return { type: 'content_block_stop', index } as any
}

function makeMessageDelta(
  stopReason: string,
  outputTokens: number,
): BetaRawMessageStreamEvent {
  return {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: outputTokens },
  } as any
}

function makeMessageStop(): BetaRawMessageStreamEvent {
  return { type: 'message_stop' } as any
}

/** A 429 the unified detector recognizes via its `status` field. */
function make429(): Error {
  return Object.assign(new Error('429 Too many concurrent requests'), {
    status: 429,
  })
}

/** An abort shaped like the Anthropic SDK's APIUserAbortError. */
function makeAbort(): Error {
  return Object.assign(new Error('Request was aborted'), {
    name: 'APIUserAbortError',
  })
}

// ─── module-level controls ───────────────────────────────────────────────────

let _adaptEvents: BetaRawMessageStreamEvent[] = []
let _adaptThrowAfterOutput = false
let _createCalls = 0
let _failCreateWith429Until = 0
let _createAbort = false
let _searchExtraToolsEnabled = false
let _lastCreateArgs: Record<string, any> | null = null

/** Stands in for the real stream adapter: emits canned events, then optionally
 * throws a 429 to simulate a mid-stream rate limit after output began. */
async function* adaptGen() {
  for (const e of _adaptEvents) yield e
  if (_adaptThrowAfterOutput) throw make429()
}

// ─── mocks ───────────────────────────────────────────────────────────────────

// Retries call the real sleeper; make it resolve instantly so tests never wait.
mock.module('src/utils/sleep.ts', () => ({
  sleep: async () => {},
  withTimeout: (p: Promise<unknown>) => p,
}))

mock.module('@ant/model-provider', () => ({
  resolveOpenAIModel: (m: string) => m,
  adaptOpenAIStreamToAnthropic: () => adaptGen(),
  anthropicMessagesToOpenAI: (messages: any[]) =>
    messages.map(msg => ({
      role: msg.message?.role ?? 'user',
      content: msg.message?.content ?? '',
    })),
  anthropicToolsToOpenAI: (tools: any[]) =>
    tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description ?? '',
        parameters: tool.input_schema ?? { type: 'object', properties: {} },
      },
    })),
  anthropicToolChoiceToOpenAI: () => undefined,
  normalizeOpenAIUsage: (params: {
    totalInputTokens: number
    outputTokens: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
  }) => ({
    input_tokens: Math.max(0, params.totalInputTokens),
    output_tokens: Math.max(0, params.outputTokens),
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  }),
}))

mock.module('../../../../services/analytics/growthbook.js', () => ({
  getFeatureValue_CACHED_MAY_BE_STALE: (_key: string, fallback: unknown) =>
    fallback,
  checkStatsigFeatureGate_CACHED_MAY_BE_STALE: () => false,
  getFeatureValue_CACHED_WITH_REFRESH: (_key: string, fallback: unknown) =>
    fallback,
}))

// Force the Chat Completions path (not ChatGPT Responses) so the client stub
// and stream-adapter mocks are the ones exercised.
mock.module('../chatgptAuth.js', () => ({
  isChatGPTAuthEnabled: () => false,
  getValidChatGPTAuth: async () => null,
}))

mock.module('bun:bundle', () => ({
  feature: () => false,
}))

mock.module('../client.js', () => ({
  getOpenAIClient: () => ({
    chat: {
      completions: {
        create: async (args: Record<string, any>) => {
          _createCalls++
          _lastCreateArgs = args
          if (_createAbort) throw makeAbort()
          if (_createCalls <= _failCreateWith429Until) throw make429()
          return { [Symbol.asyncIterator]: async function* () {} }
        },
      },
    },
  }),
}))

mock.module('../streamAdapter.js', () => ({
  adaptOpenAIStreamToAnthropic: () => adaptGen(),
}))

mock.module('../modelMapping.js', () => ({
  resolveOpenAIModel: (m: string) => m,
}))

mock.module('../convertMessages.js', () => ({
  anthropicMessagesToOpenAI: () => [],
}))

mock.module('../convertTools.js', () => ({
  anthropicToolsToOpenAI: () => [],
  anthropicToolChoiceToOpenAI: () => undefined,
}))

mock.module('../../../../utils/context.js', () => ({
  MODEL_CONTEXT_WINDOW_DEFAULT: 200_000,
  COMPACT_MAX_OUTPUT_TOKENS: 20_000,
  CAPPED_DEFAULT_MAX_TOKENS: 8_000,
  ESCALATED_MAX_TOKENS: 64_000,
  is1mContextDisabled: () => false,
  has1mContext: () => false,
  modelSupports1M: () => false,
  getModelMaxOutputTokens: () => ({ upperLimit: 8192, default: 8192 }),
  getContextWindowForModel: () => 200_000,
  getSonnet1mExpTreatmentEnabled: () => false,
  calculateContextPercentages: () => ({
    usedPercent: 0,
    remainingPercent: 100,
  }),
  getMaxThinkingTokensForModel: () => 0,
}))

mock.module('../../../../utils/messages.js', () => ({
  normalizeMessagesForAPI: (msgs: any) => msgs,
  normalizeContentFromAPI: (blocks: any[]) => blocks,
  createUserMessage: (opts: any) => ({
    type: 'user',
    message: { role: 'user', content: opts.content },
    uuid: 'user-uuid',
    timestamp: new Date().toISOString(),
    isMeta: opts.isMeta,
  }),
  createAssistantAPIErrorMessage: (opts: any) => ({
    type: 'assistant',
    message: {
      content: [{ type: 'text', text: opts.content }],
      apiError: opts.apiError,
    },
    uuid: 'error-uuid',
    timestamp: new Date().toISOString(),
  }),
}))

mock.module('../../../../utils/api.js', () => ({
  toolToAPISchema: async (t: any) => t,
}))

mock.module('../../../../utils/searchExtraTools.js', () => ({
  isSearchExtraToolsEnabled: async () => _searchExtraToolsEnabled,
  extractDiscoveredToolNames: () => new Set(),
  isDeferredToolsDeltaEnabled: () => false,
}))

mock.module(
  '@claude-code-best/builtin-tools/tools/SearchExtraToolsTool/prompt.js',
  () => ({
    isDeferredTool: () => false,
    formatDeferredToolLine: () => '',
    SEARCH_EXTRA_TOOLS_TOOL_NAME: '__tool_search__',
  }),
)

mock.module('../../../../cost-tracker.js', () => ({
  addToTotalSessionCost: () => {},
}))

mock.module('../../../../utils/modelCost.js', () => ({
  COST_TIER_3_15: {},
  COST_TIER_15_75: {},
  COST_TIER_5_25: {},
  COST_TIER_30_150: {},
  COST_HAIKU_35: {},
  COST_HAIKU_45: {},
  getOpus46CostTier: () => ({}),
  MODEL_COSTS: {},
  getModelCosts: () => ({}),
  calculateUSDCost: () => 0,
  calculateCostFromTokens: () => 0,
  formatModelPricing: () => '',
  getModelPricingString: () => undefined,
}))

mock.module('src/services/langfuse/tracing.ts', () => ({
  createTrace: () => null,
  recordLLMObservation: () => {},
  recordToolObservation: () => {},
  createToolBatchSpan: () => null,
  endToolBatchSpan: () => {},
  createSubagentTrace: () => null,
  createChildSpan: () => null,
  endTrace: () => {},
}))

mock.module('../../../../services/langfuse/convert.js', () => ({
  convertMessagesToLangfuse: () => [],
  convertOutputToLangfuse: () => ({}),
  convertToolsToLangfuse: () => [],
}))

mock.module('../../../../utils/debug.js', () => ({
  logForDebugging: () => {},
  logAntError: () => {},
  isDebugMode: () => false,
  isDebugToStdErr: () => false,
  getDebugFilePath: () => null,
  getDebugLogPath: () => '',
  getDebugFilter: () => null,
  getMinDebugLogLevel: () => 'debug',
  enableDebugLogging: () => false,
  setHasFormattedOutput: () => {},
  getHasFormattedOutput: () => false,
  flushDebugLogs: async () => {},
}))

// ─── runner ──────────────────────────────────────────────────────────────────

async function runQueryModel(signal?: AbortSignal) {
  const { queryModelOpenAI } = await import('../index.js')

  const assistantMessages: AssistantMessage[] = []
  const streamEvents: StreamEvent[] = []
  const otherOutputs: any[] = []

  const minimalOptions: any = {
    model: 'test-model',
    tools: [],
    agents: [],
    querySource: 'main_loop',
    getToolPermissionContext: async () => ({
      alwaysAllow: [],
      alwaysDeny: [],
      needsPermission: [],
      mode: 'default',
      isBypassingPermissions: false,
    }),
  }

  for await (const item of queryModelOpenAI(
    [],
    { type: 'text', text: '' } as any,
    [],
    signal ?? new AbortController().signal,
    minimalOptions,
  )) {
    if (item.type === 'assistant') {
      assistantMessages.push(item as AssistantMessage)
    } else if (item.type === 'stream_event') {
      streamEvents.push(item as StreamEvent)
    } else {
      otherOutputs.push(item)
    }
  }

  return { assistantMessages, streamEvents, otherOutputs }
}

// ─── tests ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  _adaptEvents = []
  _adaptThrowAfterOutput = false
  _createCalls = 0
  _failCreateWith429Until = 0
  _createAbort = false
  _searchExtraToolsEnabled = false
  _lastCreateArgs = null
})

describe('queryModelOpenAI — rate-limit retry wiring', () => {
  test('429 at create-time before any output is retried once with correct final events', async () => {
    _failCreateWith429Until = 1
    _adaptEvents = [
      makeMessageStart(),
      makeContentBlockStart(0, 'text'),
      makeTextDelta(0, 'Hello'),
      makeContentBlockStop(0),
      makeMessageDelta('end_turn', 5),
      makeMessageStop(),
    ]

    const { assistantMessages } = await runQueryModel()

    // Exactly one retry: the failed create() plus the successful one.
    expect(_createCalls).toBe(2)
    expect(assistantMessages).toHaveLength(1)
    // The successful attempt's message is clean — no API-error signal lingers.
    expect((assistantMessages[0]!.message as any).apiError).toBeUndefined()
    expect(assistantMessages[0]!.message.stop_reason).toBe('end_turn')
  })

  test('429 after visible text output is not retried and surfaces as api_error', async () => {
    _adaptThrowAfterOutput = true
    _adaptEvents = [
      makeMessageStart(),
      makeContentBlockStart(0, 'text'),
      makeTextDelta(0, 'partial answer'),
    ]

    const { assistantMessages } = await runQueryModel()

    // Never replayed once the user has seen text.
    expect(_createCalls).toBe(1)
    expect(assistantMessages).toHaveLength(1)
    expect((assistantMessages[0]!.message as any).apiError).toBe('api_error')
  })

  test('user abort (APIUserAbortError) never becomes an API Error message', async () => {
    _createAbort = true
    _adaptEvents = [makeMessageStart()]

    const { assistantMessages, otherOutputs } = await runQueryModel()

    expect(_createCalls).toBe(1)
    expect(assistantMessages).toHaveLength(0)
    expect(otherOutputs).toHaveLength(0)
  })

  test('pre-aborted signal short-circuits before any create call', async () => {
    const ac = new AbortController()
    ac.abort()
    _adaptEvents = [makeMessageStart()]

    const { assistantMessages, otherOutputs } = await runQueryModel(ac.signal)

    expect(_createCalls).toBe(0)
    expect(assistantMessages).toHaveLength(0)
    expect(otherOutputs).toHaveLength(0)
  })
})
