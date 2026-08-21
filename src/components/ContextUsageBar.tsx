import * as React from 'react';
import { memo } from 'react';
import { getSdkBetas } from '../bootstrap/state.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import type { Message } from '../types/message.js';
import { computeHitRate } from '../utils/cacheStats.js';
import { formatTokens } from '../utils/format.js';
import { getContextWindowForModel } from '../utils/context.js';
import { getCurrentUsage, getPostCompactTokenEstimate } from '../utils/tokens.js';
import { Box, Text } from '@anthropic/ink';

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

function ContextUsageBarInner({ messages, model }: Props): React.ReactNode {
  const { columns } = useTerminalSize();
  const data = getContextMeterData(messages, model);
  const barWidth = columns < 60 ? 8 : 12;
  const filled =
    data.usedPercentage === null ? 0 : Math.min(barWidth, Math.round((data.usedPercentage / 100) * barWidth));
  const contextColor =
    data.usedPercentage !== null && data.usedPercentage >= 90
      ? 'error'
      : data.usedPercentage !== null && data.usedPercentage >= 75
        ? 'warning'
        : 'suggestion';
  const cacheColor = data.cacheHitRate !== null && data.cacheHitRate < 80 ? 'warning' : 'success';

  return (
    <Box paddingX={2} width="100%">
      <Text color="subtle">Context </Text>
      <Text color={contextColor}>{'█'.repeat(filled)}</Text>
      <Text color="inactive">{'░'.repeat(barWidth - filled)}</Text>
      <Text color={contextColor}>
        {' '}
        {data.usedPercentage === null ? '--' : `${data.usedTokensEstimated ? '~' : ''}${data.usedPercentage}`}%
      </Text>
      {columns >= 60 && (
        <Text color="subtle">
          {' '}
          ({data.usedTokens === null ? '--' : `${data.usedTokensEstimated ? '~' : ''}${formatTokens(data.usedTokens)}`}/
          {formatTokens(data.contextWindowSize)})
        </Text>
      )}
      <Text color="subtle"> · Cache </Text>
      {data.cacheHitRate === null ? (
        <Text color="inactive">--</Text>
      ) : (
        <Text color={cacheColor}>{data.cacheHitRate}%</Text>
      )}
    </Box>
  );
}

export const ContextUsageBar = memo(ContextUsageBarInner);
