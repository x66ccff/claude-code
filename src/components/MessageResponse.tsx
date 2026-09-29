import { feature } from 'bun:bundle';
import * as React from 'react';
import { useContext } from 'react';
import { Box, NoSelect, Text, Ratchet } from '@anthropic/ink';
import { InVirtualListContext } from './messageActions.js';

type Props = {
  children: React.ReactNode;
  height?: number;
};

// OUTPUT_STATS: when a tool-result renderer is wrapped in this provider
// (UserToolSuccessMessage / UserToolErrorMessage), the outermost
// MessageResponse appends the tool's wall-clock duration as a gray suffix.
// The suffix sits in the same flex row as the result content; with the
// default stretch alignment its text renders at the top line — i.e. right
// after the tool's own one-line summary: `⎿  Did 1 search in 2s (2.1s)`.
export const ToolDurationContext = React.createContext<string | undefined>(undefined);

export function ToolDurationProvider({
  durationText,
  children,
}: {
  durationText: string | undefined;
  children: React.ReactNode;
}): React.ReactNode {
  if (feature('OUTPUT_STATS')) {
    return durationText ? (
      <ToolDurationContext.Provider value={durationText}>{children}</ToolDurationContext.Provider>
    ) : (
      children
    );
  }
  return children;
}

export function MessageResponse({ children, height }: Props): React.ReactNode {
  const isMessageResponse = useContext(MessageResponseContext);
  const durationText = useContext(ToolDurationContext);
  const inVirtualList = useContext(InVirtualListContext);
  if (isMessageResponse) {
    return children;
  }
  const content = (
    <MessageResponseProvider>
      <Box flexDirection="row" height={height} overflowY="hidden">
        <NoSelect fromLeftEdge flexShrink={0}>
          <Text dimColor>{'  '}⎿ &nbsp;</Text>
        </NoSelect>
        <Box flexShrink={1} flexGrow={1}>
          {children}
        </Box>
        {feature('OUTPUT_STATS') && durationText ? (
          <NoSelect flexShrink={0}>
            <Text dimColor>&nbsp;({durationText})</Text>
          </NoSelect>
        ) : null}
      </Box>
    </MessageResponseProvider>
  );
  // Virtual spacers own scroll height; a scrollback ratchet would preserve collapsed blank rows.
  if (height !== undefined || inVirtualList) {
    return content;
  }
  return <Ratchet lock="offscreen">{content}</Ratchet>;
}

// This is a context that is used to determine if the message response
// is rendered as a descendant of another MessageResponse. We use it
// to avoid rendering nested ⎿ characters.
const MessageResponseContext = React.createContext(false);

function MessageResponseProvider({ children }: { children: React.ReactNode }): React.ReactNode {
  return <MessageResponseContext.Provider value={true}>{children}</MessageResponseContext.Provider>;
}
