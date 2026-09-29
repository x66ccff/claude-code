import { randomUUID } from 'crypto'
import { getInitialSettings } from './settings/settings.js'
import type { Message } from '../types/message.js'

// Usage 类型（从 API 响应中提取）
interface Usage {
  input_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
}

export interface CacheHitRateInfo {
  hitRate: number
  threshold: number
  trend: number | null // 正数=上升，负数=下降
  shouldWarn: boolean
}

interface CacheWarningState {
  lastHitRate: number | null
  lastTimestamp: number | null
  lastWarnTimestamp: number | null
  lastWarnHitRate: number | null
}

// 注入冷却。没有冷却时，一个 0% 命中的长回合每次 API 往返都会往 transcript
// 注入一条相同的警告消息：既是噪音，又会让 messages.length 在用户上翻过程中
// 反复变化——虚拟滚动的锚定补偿以 n 不变为前提（useVirtualScroll），每条注入
// 都制造一次"锚定失效窗口"，表现为上翻时同一内容区被反复"回放"。
// 同一 source 在冷却窗口内最多警告一次，除非命中率显著恶化。
const WARN_COOLDOWN_MS = 5 * 60 * 1000
const WARN_WORSEN_PP = 10

// 模块级状态，每个 querySource 独立跟踪
const cacheWarningStateBySource = new Map<string, CacheWarningState>()

// Limit the number of tracked sources to prevent unbounded Map growth.
// querySource strings are effectively unbounded (typed as `any`), so a
// long-running session that spawns many subagents could leak memory.
// Evict the oldest entry (by insertion order) when the limit is exceeded.
const MAX_SOURCE_ENTRIES = 50

const DEFAULT_CACHE_THRESHOLD = 70

/**
 * 从 settings.json 读取缓存阈值配置
 */
export function getCacheThreshold(): number {
  const settings = getInitialSettings()
  return settings.cacheThreshold ?? DEFAULT_CACHE_THRESHOLD
}

/**
 * 检查缓存警告是否启用。默认 true。
 */
export function isCacheWarningEnabled(): boolean {
  const settings = getInitialSettings()
  return settings.cacheWarningEnabled ?? true
}

/**
 * 计算缓存命中率
 * 返回值范围 0-100，null 表示无有效数据
 */
export function calculateCacheHitRate(
  usage: Usage | null | undefined,
): number | null {
  if (!usage) return null

  const { input_tokens, cache_creation_input_tokens, cache_read_input_tokens } =
    usage

  // 所有缓存字段为 0 表示无缓存数据
  if (cache_read_input_tokens === 0 && cache_creation_input_tokens === 0) {
    return null
  }

  const totalInputTokens =
    input_tokens + cache_creation_input_tokens + cache_read_input_tokens
  if (totalInputTokens === 0) return null

  return (cache_read_input_tokens / totalInputTokens) * 100
}

/**
 * 检测是否需要显示缓存警告
 * @param usage API usage 数据
 * @param querySource 查询来源（用于独立跟踪状态）
 * @param threshold 缓存阈值百分比
 * @returns 警告信息，如果不需要警告则返回 null
 */
export function shouldShowCacheWarning(
  usage: Usage | null | undefined,
  querySource: string,
  threshold: number,
): CacheHitRateInfo | null {
  const hitRate = calculateCacheHitRate(usage)

  // 无缓存数据
  if (hitRate === null) {
    return null
  }

  // 获取或初始化该 querySource 的状态
  let state = cacheWarningStateBySource.get(querySource)
  if (!state) {
    state = {
      lastHitRate: null,
      lastTimestamp: null,
      lastWarnTimestamp: null,
      lastWarnHitRate: null,
    }
    // Evict oldest entry when at capacity so the Map stays bounded
    if (cacheWarningStateBySource.size >= MAX_SOURCE_ENTRIES) {
      const oldestKey = cacheWarningStateBySource.keys().next().value
      if (oldestKey !== undefined) {
        cacheWarningStateBySource.delete(oldestKey)
      }
    }
    cacheWarningStateBySource.set(querySource, state)
  }

  // 首次请求不显示警告
  if (state.lastHitRate === null) {
    state.lastHitRate = hitRate
    state.lastTimestamp = Date.now()
    return null
  }

  // 计算趋势
  const trend = hitRate - state.lastHitRate

  // 更新状态
  state.lastHitRate = hitRate
  state.lastTimestamp = Date.now()

  // 检查是否需要警告（带冷却，见 WARN_COOLDOWN_MS 注释）
  if (hitRate < threshold) {
    const now = Date.now()
    const cooledDown =
      state.lastWarnTimestamp === null ||
      now - state.lastWarnTimestamp >= WARN_COOLDOWN_MS ||
      (state.lastWarnHitRate !== null &&
        hitRate <= state.lastWarnHitRate - WARN_WORSEN_PP)
    if (cooledDown) {
      state.lastWarnTimestamp = now
      state.lastWarnHitRate = hitRate
      return { hitRate, threshold, trend, shouldWarn: true }
    }
    return null
  }

  return null
}

/**
 * 生成缓存警告消息
 * @param info 缓存警告信息
 * @returns system 类型消息，在 REPL 主界面和 transcript 模式下可见
 */
export function createCacheWarningMessage(info: CacheHitRateInfo): Message {
  const { hitRate, threshold, trend } = info

  let content = `Cache hit rate ${hitRate.toFixed(0)}%, below ${threshold}% threshold`

  if (trend !== null && Math.abs(trend) > 0.1) {
    const trendIcon = trend > 0 ? '^' : 'v'
    const trendPercent = Math.abs(trend).toFixed(0)
    content += ` (${trendIcon}${trendPercent}%)`
  }

  return {
    type: 'system',
    subtype: 'cache_warning',
    level: 'warning' as const,
    content,
    timestamp: new Date().toISOString(),
    uuid: randomUUID(),
    isMeta: false,
  } as Message
}

/**
 * Reset the per-source tracking state — only used in tests.
 */
export function _resetCacheWarningStateForTest(): void {
  cacheWarningStateBySource.clear()
}
