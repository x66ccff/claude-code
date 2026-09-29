import { feature } from 'bun:bundle';
import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs';
import * as React from 'react';
import type { Tools } from '../../../Tool.js';
import type { NormalizedUserMessage, ProgressMessage } from '../../../types/message.js';
import { formatToolDuration } from '../../../utils/format.js';
import {
  type buildMessageLookups,
  CANCEL_MESSAGE,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
  REJECT_MESSAGE,
} from '../../../utils/messages.js';
import { ToolDurationProvider } from '../../MessageResponse.js';
import { UserToolCanceledMessage } from './UserToolCanceledMessage.js';
import { UserToolErrorMessage } from './UserToolErrorMessage.js';
import { UserToolRejectMessage } from './UserToolRejectMessage.js';
import { UserToolSuccessMessage } from './UserToolSuccessMessage.js';
import { useGetToolFromMessages } from './utils.js';

type Props = {
  param: ToolResultBlockParam;
  message: NormalizedUserMessage;
  lookups: ReturnType<typeof buildMessageLookups>;
  progressMessagesForMessage: ProgressMessage[];
  style?: 'condensed';
  tools: Tools;
  verbose: boolean;
  width: number | string;
  isTranscriptMode?: boolean;
  shouldCollapseDiffs?: boolean;
};

export function UserToolResultMessage({
  param,
  message,
  lookups,
  progressMessagesForMessage,
  style,
  tools,
  verbose,
  width,
  isTranscriptMode,
  shouldCollapseDiffs,
}: Props): React.ReactNode {
  const toolUse = useGetToolFromMessages(param.tool_use_id, tools, lookups);
  if (!toolUse) {
    return null;
  }

  // OUTPUT_STATS: gray `(2.1s)` suffix on the ⎿ result row, sourced from the
  // top-level toolDurationMs field stamped at message creation in
  // toolExecution.ts (absent on older transcripts). Covers both success and
  // error/interrupt branches below.
  const durationText = feature('OUTPUT_STATS')
    ? typeof message.toolDurationMs === 'number' && message.toolDurationMs >= 0
      ? formatToolDuration(message.toolDurationMs)
      : undefined
    : undefined;

  if (typeof param.content === 'string' && param.content.startsWith(CANCEL_MESSAGE)) {
    return <UserToolCanceledMessage />;
  }

  if (
    (typeof param.content === 'string' && param.content.startsWith(REJECT_MESSAGE)) ||
    param.content === INTERRUPT_MESSAGE_FOR_TOOL_USE
  ) {
    return (
      <UserToolRejectMessage
        input={toolUse.toolUse.input as { [key: string]: unknown }}
        progressMessagesForMessage={progressMessagesForMessage}
        tool={toolUse.tool}
        tools={tools}
        lookups={lookups}
        style={style}
        verbose={verbose}
        isTranscriptMode={isTranscriptMode}
      />
    );
  }

  if (param.is_error) {
    return (
      <ToolDurationProvider durationText={durationText}>
        <UserToolErrorMessage
          progressMessagesForMessage={progressMessagesForMessage}
          tool={toolUse.tool}
          tools={tools}
          param={param}
          verbose={verbose}
          isTranscriptMode={isTranscriptMode}
        />
      </ToolDurationProvider>
    );
  }

  return (
    <ToolDurationProvider durationText={durationText}>
      <UserToolSuccessMessage
        message={message}
        lookups={lookups}
        toolUseID={toolUse.toolUse.id}
        progressMessagesForMessage={progressMessagesForMessage}
        style={style}
        tool={toolUse.tool}
        tools={tools}
        verbose={verbose}
        width={width}
        isTranscriptMode={isTranscriptMode}
        shouldCollapseDiffs={shouldCollapseDiffs}
      />
    </ToolDurationProvider>
  );
}
