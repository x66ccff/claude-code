import * as React from 'react';
import type { HookEvent } from 'src/entrypoints/agentSdkTypes.js';
import type { HookProgress } from 'src/types/hooks.js';
import type { buildMessageLookups } from 'src/utils/messages.js';
import { Box, Text } from '@anthropic/ink';
import { MessageResponse } from '../MessageResponse.js';

type Props = {
  hookEvent: HookEvent;
  lookups: ReturnType<typeof buildMessageLookups>;
  toolUseID: string;
  verbose: boolean;
  isTranscriptMode?: boolean;
};

export function HookProgressMessage({
  hookEvent,
  lookups,
  toolUseID,
  verbose,
  isTranscriptMode,
}: Props): React.ReactNode {
  const resolvedHookKeys = lookups.resolvedHookKeys.get(toolUseID)?.get(hookEvent);
  const progressMessages = (lookups.progressMessagesByToolUseID.get(toolUseID) ?? []).filter(message => {
    const data = message.data as HookProgress;
    return data.type === 'hook_progress' && data.hookEvent === hookEvent && !resolvedHookKeys?.has(data.hookId);
  });

  if (progressMessages.length === 0) {
    return null;
  }

  return (
    <Box flexDirection="column">
      {progressMessages.map(message => {
        const data = message.data as HookProgress;
        return (
          <MessageResponse key={data.hookId}>
            <Box flexDirection="column">
              <Text dimColor>
                Hook {data.hookEvent} · {data.hookSource} · {data.hookType} ·{' '}
                {isTranscriptMode ? 'started' : 'running…'}
              </Text>
              {verbose ? <Text dimColor>input: {data.command}</Text> : null}
            </Box>
          </MessageResponse>
        );
      })}
    </Box>
  );
}
