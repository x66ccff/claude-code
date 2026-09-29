import { Box, Text } from '@anthropic/ink';
import { type ReactNode, useMemo, useSyncExternalStore } from 'react';
import type { Message } from '../types/message.js';
import type { HookProgress } from '../types/hooks.js';
import type { HookExecutionAttachment } from '../utils/attachments.js';
import { getRawRequestSnapshot, subscribeRawRequestSnapshot } from '../services/api/rawRequestSnapshot.js';
import { MessageResponse } from './MessageResponse.js';
import { AttachmentMessage } from './messages/AttachmentMessage.js';

type HookStatus = { type: 'progress'; data: HookProgress } | { type: 'result'; data: HookExecutionAttachment };

function getHookStatuses(messages: Message[]): HookStatus[] {
  const statuses = new Map<string, HookStatus>();
  for (const message of messages) {
    if (message.type === 'progress') {
      const data = message.data as HookProgress | undefined;
      if (data?.type === 'hook_progress') {
        statuses.set(data.hookId, { type: 'progress', data });
      }
      continue;
    }
    if (message.type === 'attachment' && message.attachment?.type === 'hook_execution') {
      const attachment = message.attachment as unknown as HookExecutionAttachment;
      statuses.set(attachment.hookId, { type: 'result', data: attachment });
    }
  }
  return [...statuses.values()];
}

export function RawRequestView({
  messages = [],
  verbose = false,
}: {
  messages?: Message[];
  verbose?: boolean;
}): ReactNode {
  const snapshot = useSyncExternalStore(subscribeRawRequestSnapshot, getRawRequestSnapshot, getRawRequestSnapshot);
  const hookStatuses = useMemo(() => getHookStatuses(messages), [messages]);

  return (
    <Box flexDirection="column">
      <Text bold>Raw model request</Text>
      {snapshot ? (
        <>
          <Text dimColor>
            {snapshot.provider} · {new Date(snapshot.capturedAt).toISOString()}
          </Text>
          <Text wrap="wrap">{snapshot.body}</Text>
        </>
      ) : (
        <Text dimColor>No model request has been sent in this session yet.</Text>
      )}
      {hookStatuses.map(status =>
        status.type === 'progress' ? (
          <MessageResponse key={status.data.hookId}>
            <Box flexDirection="column">
              <Text dimColor>
                Hook {status.data.hookEvent} · {status.data.hookSource} · {status.data.hookType} · running…
              </Text>
              {verbose ? <Text dimColor>input: {status.data.command}</Text> : null}
            </Box>
          </MessageResponse>
        ) : (
          <AttachmentMessage key={status.data.hookId} attachment={status.data} addMargin={false} verbose={verbose} />
        ),
      )}
    </Box>
  );
}
