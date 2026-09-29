import { describe, expect, test } from 'bun:test';
import * as React from 'react';
import type { HookProgress } from '../../../types/hooks.js';
import { createAttachmentMessage } from '../../../utils/attachments.js';
import { buildMessageLookups, createProgressMessage } from '../../../utils/messages.js';
import { renderToString } from '../../../utils/staticRender.js';
import { HookProgressMessage } from '../HookProgressMessage.js';

function progress(hookId: string, hookSource: string, command: string) {
  return createProgressMessage<HookProgress>({
    toolUseID: 'tool-1',
    parentToolUseID: 'tool-1',
    data: {
      type: 'hook_progress',
      hookId,
      hookEvent: 'PreToolUse',
      hookName: 'Bash',
      hookSource,
      hookType: 'command',
      command,
    },
  });
}

function completion(hookId: string) {
  return createAttachmentMessage({
    type: 'hook_execution',
    hookId,
    hookName: 'Bash',
    toolUseID: 'tool-1',
    hookEvent: 'PreToolUse',
    hookSource: 'plugin:one',
    hookType: 'command',
    outcome: 'success',
    durationMs: 3,
  });
}

describe.skipIf(!!process.env.CI)('HookProgressMessage', () => {
  test('keeps only unresolved concurrent Hook runs visible', async () => {
    const messages = [
      progress('run-1', 'plugin:one', 'printf one'),
      progress('run-2', 'plugin:two', 'printf two'),
      completion('run-1'),
    ];
    const lookups = buildMessageLookups(messages as any, messages as any);

    const output = await renderToString(
      <HookProgressMessage hookEvent="PreToolUse" lookups={lookups} toolUseID="tool-1" verbose={false} />,
    );

    expect(output).not.toContain('plugin:one');
    expect(output).toContain('Hook PreToolUse · plugin:two · command · running…');
  });

  test('shows sanitized input only in verbose mode', async () => {
    const messages = [progress('run-1', 'settings', 'printf ok')];
    const lookups = buildMessageLookups(messages as any, messages as any);

    const compact = await renderToString(
      <HookProgressMessage hookEvent="PreToolUse" lookups={lookups} toolUseID="tool-1" verbose={false} />,
    );
    const verbose = await renderToString(
      <HookProgressMessage hookEvent="PreToolUse" lookups={lookups} toolUseID="tool-1" verbose />,
    );

    expect(compact).not.toContain('input:');
    expect(verbose).toContain('input: printf ok');
  });

  test('renders a stable started label in transcript mode', async () => {
    const messages = [progress('run-1', 'settings', 'printf ok')];
    const lookups = buildMessageLookups(messages as any, messages as any);

    const output = await renderToString(
      <HookProgressMessage
        hookEvent="PreToolUse"
        lookups={lookups}
        toolUseID="tool-1"
        verbose={false}
        isTranscriptMode
      />,
    );

    expect(output).toContain('Hook PreToolUse · settings · command · started');
    expect(output).not.toContain('running');
  });

  test('does not hide an allowed run when an unrelated policy rejection exists', async () => {
    const messages = [
      progress('run-1', 'settings', 'printf ok'),
      createAttachmentMessage({
        type: 'hook_execution',
        hookId: 'rejected-1',
        hookName: 'Bash',
        toolUseID: 'tool-1',
        hookEvent: 'PreToolUse',
        hookSource: 'plugin:blocked',
        hookType: 'command',
        outcome: 'rejected',
        durationMs: 0,
      }),
    ];
    const lookups = buildMessageLookups(messages as any, messages as any);

    const output = await renderToString(
      <HookProgressMessage hookEvent="PreToolUse" lookups={lookups} toolUseID="tool-1" verbose={false} />,
    );

    expect(output).toContain('Hook PreToolUse · settings · command · running…');
  });

  test('renders nothing after every Hook run resolves', async () => {
    const messages = [progress('run-1', 'settings', 'printf ok'), completion('run-1')];
    const lookups = buildMessageLookups(messages as any, messages as any);

    const output = await renderToString(
      <HookProgressMessage hookEvent="PreToolUse" lookups={lookups} toolUseID="tool-1" verbose={false} />,
    );

    expect(output.trim()).toBe('');
  });
});
