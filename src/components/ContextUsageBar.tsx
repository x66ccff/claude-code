import * as React from 'react';
import { memo } from 'react';
import { getSdkBetas } from '../bootstrap/state.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { useAppState } from '../state/AppState.js';
import type { Tool } from '../Tool.js';
import type { Message } from '../types/message.js';
import { computeHitRate } from '../utils/cacheStats.js';
import {
  estimateContextSegmentsOnce,
  getCachedContextSegmentEstimate,
  splitUsedTokensIntoSegments,
} from '../utils/contextEstimation.js';
import { formatTokens } from '../utils/format.js';
import { getContextWindowForModel } from '../utils/context.js';
import { getCurrentUsage, getPostCompactTokenEstimate } from '../utils/tokens.js';
import { interpolateColor, parseRGB, toRGBColor } from './Spinner/utils.js';
import { getTools } from '../tools.js';
import { Box, Text, getTheme, useTheme } from '@anthropic/ink';

type Props = {
  messages: Message[];
  model: string;
};

export interface ContextMeterData {
  usedTokens: number | null;
  contextWindowSize: number;
  usedPercentage: number | null;
  cacheHitRate: number | null;
  usedTokensEstimated: boolean;
}

export function getContextMeterData(messages: Message[], model: string): ContextMeterData {
  const contextWindowSize = getContextWindowForModel(model, getSdkBetas());
  const usage = getCurrentUsage(messages);

  if (!usage) {
    const estimatedTokens = getPostCompactTokenEstimate(messages);
    if (estimatedTokens !== null) {
      return {
        usedTokens: estimatedTokens,
        contextWindowSize,
        usedPercentage: Math.min(100, Math.max(0, Math.round((estimatedTokens / contextWindowSize) * 100))),
        cacheHitRate: null,
        usedTokensEstimated: true,
      };
    }
    return {
      usedTokens: null,
      contextWindowSize,
      usedPercentage: null,
      cacheHitRate: null,
      usedTokensEstimated: false,
    };
  }

  const usedTokens =
    usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens + usage.output_tokens;
  const usedPercentage = Math.min(100, Math.max(0, Math.round((usedTokens / contextWindowSize) * 100)));

  return {
    usedTokens,
    contextWindowSize,
    usedPercentage,
    cacheHitRate: computeHitRate(usage),
    usedTokensEstimated: false,
  };
}

type BarColor = NonNullable<React.ComponentProps<typeof Text>['color']>;
type BarSegment = { cells: number; color: BarColor };

function ContextUsageBarInner({ messages, model }: Props): React.ReactNode {
  const { columns } = useTerminalSize();
  const [themeName] = useTheme();
  const palette = React.useMemo<BarColor[]>(() => {
    const theme = getTheme(themeName);
    const orange = parseRGB(theme.claude);
    const foreground = parseRGB(theme.text);
    return orange && foreground
      ? [0.45, 0.3, 0.15, 0].map(amount => toRGBColor(interpolateColor(orange, foreground, amount)))
      : ['ansi:yellow', 'ansi:red', 'ansi:yellowBright', 'ansi:redBright'];
  }, [themeName]);
  const data = getContextMeterData(messages, model);
  // 4x the original width (was 8/12 → now 32/48), clamped so bar + labels +
  // percentage + token totals + cache rate still fit on narrow terminals.
  const barWidth = Math.max(8, Math.min(columns < 60 ? 32 : 48, columns - 46));
  const filled =
    data.usedPercentage === null ? 0 : Math.min(barWidth, Math.round((data.usedPercentage / 100) * barWidth));
  const contextColor =
    data.usedPercentage !== null && data.usedPercentage >= 90
      ? 'error'
      : data.usedPercentage !== null && data.usedPercentage >= 75
        ? 'warning'
        : 'claude';
  const cacheColor = data.cacheHitRate !== null && data.cacheHitRate < 80 ? 'warning' : 'claude';

  const toolPermissionContext = useAppState(s => s.toolPermissionContext);
  const agentDefinitions = useAppState(s => s.agentDefinitions);
  const mcpTools = useAppState(s => s.mcp.tools);
  const [estimate, setEstimate] = React.useState(getCachedContextSegmentEstimate);

  React.useEffect(() => {
    if (estimate) {
      return;
    }
    let cancelled = false;
    // Merge builtin tools with connected MCP tools (dedup by name) so the
    // tools segment reflects what real requests actually send.
    const byName = new Map<string, Tool>();
    for (const t of getTools(toolPermissionContext)) byName.set(t.name, t);
    for (const t of mcpTools ?? []) if (!byName.has(t.name)) byName.set(t.name, t);
    estimateContextSegmentsOnce({
      tools: [...byName.values()],
      model,
      getToolPermissionContext: async () => toolPermissionContext,
      agents: agentDefinitions.activeAgents,
    }).then(e => {
      if (!cancelled && e.systemTokens + e.toolsTokens + e.memoryTokens > 0) {
        setEstimate(e);
      }
    });
    return () => {
      cancelled = true;
    };
    // Once-per-session by design (module-level cache); deps intentionally
    // limited to the initial mount inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [estimate]);

  const segments = React.useMemo<BarSegment[] | null>(() => {
    if (!estimate || data.usedTokens === null || data.usedTokens <= 0 || filled <= 0) {
      return null;
    }
    const split = splitUsedTokensIntoSegments(data.usedTokens, estimate);
    const window = data.contextWindowSize;
    const cellOf = (tokens: number): number => (tokens / window) * barWidth;
    // Cumulative rounding keeps boundaries monotonic, and the used portion
    // ends exactly at `filled` so the bar length still matches the % text.
    const b1 = Math.min(filled, Math.round(cellOf(split.systemTokens)));
    const b2 = Math.min(filled, Math.max(b1, Math.round(cellOf(split.systemTokens + split.toolsTokens))));
    const b3 = Math.min(
      filled,
      Math.max(b2, Math.round(cellOf(split.systemTokens + split.toolsTokens + split.memoryTokens))),
    );
    return [
      { cells: b1, color: palette[0]! },
      { cells: b2 - b1, color: palette[1]! },
      { cells: b3 - b2, color: palette[2]! },
      { cells: filled - b3, color: palette[3]! },
    ];
  }, [estimate, data, barWidth, filled, palette]);

  return (
    <Box flexDirection="column" width="100%">
      <Box paddingX={2} width="100%">
        <Text color="subtle">Context </Text>
        {segments ? (
          segments.map((seg, i) =>
            seg.cells > 0 ? (
              <Text key={i} color={seg.color}>
                {'█'.repeat(seg.cells)}
              </Text>
            ) : null,
          )
        ) : (
          <Text color={contextColor}>{'█'.repeat(filled)}</Text>
        )}
        <Text color="inactive">{'░'.repeat(barWidth - filled)}</Text>
        <Text color={contextColor}>
          {' '}
          {data.usedPercentage === null ? '--' : `${data.usedTokensEstimated ? '~' : ''}${data.usedPercentage}`}%
        </Text>
        {columns >= 60 && (
          <Text color="subtle">
            {' '}
            (
            {data.usedTokens === null ? '--' : `${data.usedTokensEstimated ? '~' : ''}${formatTokens(data.usedTokens)}`}
            /{formatTokens(data.contextWindowSize)})
          </Text>
        )}
        <Text color="subtle"> · Cache </Text>
        {data.cacheHitRate === null ? (
          <Text color="inactive">--</Text>
        ) : (
          <Text color={cacheColor}>{data.cacheHitRate}%</Text>
        )}
      </Box>
      {segments && columns >= 60 && (
        <Box paddingX={2}>
          <Text color={palette[0]}>■</Text>
          <Text color="subtle"> System </Text>
          <Text color={palette[1]}>■</Text>
          <Text color="subtle"> Tools </Text>
          <Text color={palette[2]}>■</Text>
          <Text color="subtle"> Memory </Text>
          <Text color={palette[3]}>■</Text>
          <Text color="subtle"> Messages</Text>
        </Box>
      )}
    </Box>
  );
}

export const ContextUsageBar = memo(ContextUsageBarInner);
