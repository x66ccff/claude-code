import { describe, expect, test } from 'bun:test';
import * as React from 'react';
import type { HookExecutionAttachment } from '../../../utils/attachments.js';
import { renderToString } from '../../../utils/staticRender.js';
import { AttachmentMessage } from '../AttachmentMessage.js';

const attachment: HookExecutionAttachment = {
  type: 'hook_execution',
  hookId: 'run-1',
  hookName: 'Bash',
  toolUseID: 'tool-1',
  hookEvent: 'PreToolUse',
  hookSource: 'plugin:example',
  hookType: 'command',
  outcome: 'error',
  durationMs: 1250,
  displayInput: 'printf ok',
  stdout: 'standard output',
  stderr: 'failure reason',
  exitCode: 7,
};

describe.skipIf(!!process.env.CI)('AttachmentMessage hook execution', () => {
  test('renders lifecycle summary and failure reason in normal mode', async () => {
    const output = await renderToString(
      <AttachmentMessage attachment={attachment} addMargin={false} verbose={false} />,
    );

    expect(output).toContain('Hook PreToolUse · plugin:example · command · error · 1.3s');
    expect(output).toContain('exit 7: failure reason');
    expect(output).not.toContain('input:');
    expect(output).not.toContain('standard output');
  });

  test('renders diagnostic fields in verbose mode', async () => {
    const output = await renderToString(<AttachmentMessage attachment={attachment} addMargin={false} verbose />);

    expect(output).toContain('input: printf ok');
    expect(output).toContain('exit: 7');
    expect(output).toContain('stdout: standard output');
    expect(output).toContain('stderr: failure reason');
  });

  test('shows policy rejection reason in normal mode', async () => {
    const output = await renderToString(
      <AttachmentMessage
        attachment={{
          ...attachment,
          outcome: 'rejected',
          durationMs: 0,
          stderr: 'rejected by macOS policy',
          exitCode: undefined,
        }}
        addMargin={false}
        verbose={false}
      />,
    );

    expect(output).toContain('rejected · 0ms');
    expect(output).toContain('rejected by macOS policy');
  });

  test('honors suppressOutput in verbose mode', async () => {
    const output = await renderToString(
      <AttachmentMessage
        attachment={{ ...attachment, outcome: 'success', suppressOutput: true }}
        addMargin={false}
        verbose
      />,
    );

    expect(output).toContain('input: printf ok');
    expect(output).toContain('exit: 7');
    expect(output).not.toContain('standard output');
    expect(output).not.toContain('failure reason');
  });
});
