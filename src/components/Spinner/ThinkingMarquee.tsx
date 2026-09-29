import { Box, Text } from '@anthropic/ink';
import * as React from 'react';
import { truncateStartToWidth } from '../../utils/truncate.js';

// The marquee is tail-pinned: it always shows the most recent content, so as
// new deltas stream in the visible window slides left like a ticker. When the
// model stops producing content the line goes static — combined with the
// stall-red spinner animation this makes hangs visible at a glance.
const TAIL_WINDOW_CHARS = 500;
const RESERVED_COLUMNS = 4;

export function ThinkingMarquee({ text, columns }: { text: string; columns: number }): React.ReactNode {
  // Guard against very long accumulated text — only the tail can ever be visible.
  const windowText = text.length > TAIL_WINDOW_CHARS ? text.slice(-TAIL_WINDOW_CHARS) : text;
  // Flatten newlines so the ticker stays on a single line.
  const flat = windowText.replace(/\r?\n+/g, ' ⏎ ').replace(/[ \t]+/g, ' ');
  const maxWidth = Math.max(10, columns - RESERVED_COLUMNS);
  const fitted = truncateStartToWidth(flat, maxWidth);
  if (!fitted) {
    return null;
  }
  return (
    <Box flexDirection="row" width="100%" paddingLeft={2}>
      <Text dimColor>{fitted}</Text>
    </Box>
  );
}
