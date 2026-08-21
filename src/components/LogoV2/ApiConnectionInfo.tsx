import * as React from 'react';
import { Box, Text } from '@anthropic/ink';
import { getApiConnectionDisplay } from '../../utils/apiConnectionDisplay.js';
import { truncate } from '../../utils/format.js';

export function ApiConnectionInfo({
  maxWidth,
  centered = false,
}: {
  maxWidth: number;
  centered?: boolean;
}): React.ReactNode {
  const { baseUrl, credentialPreview } = getApiConnectionDisplay();

  return (
    <Box flexDirection="column" alignItems={centered ? 'center' : undefined}>
      <Text dimColor>{truncate(`Base URL: ${baseUrl}`, maxWidth)}</Text>
      <Text dimColor>{truncate(`API key: ${credentialPreview}`, maxWidth)}</Text>
    </Box>
  );
}
