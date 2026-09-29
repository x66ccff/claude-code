import { afterEach, describe, expect, test } from 'bun:test';
import * as React from 'react';
import { RawRequestView } from '../RawRequestView.js';
import { clearRawRequestSnapshot, recordRawRequestBody } from '../../services/api/rawRequestSnapshot.js';
import type { HookProgress } from '../../types/hooks.js';
import { createAttachmentMessage } from '../../utils/attachments.js';
import { createProgressMessage } from '../../utils/messages.js';
import { renderToString } from '../../utils/staticRender.js';

afterEach(() => clearRawRequestSnapshot());

describe('RawRequestView', () => {
  test('shows an empty state before the first request', async () => {
    const output = await renderToString(<RawRequestView />);

    expect(output).toContain('Raw model request');
    expect(output).toContain('No model request has been sent in this session yet.');
  });

  test('renders the captured body without JSON formatting or redaction', async () => {
    const body = '{"prompt":"model-visible-secret","nested":{"value":1}}';
    recordRawRequestBody('gemini', body);

    const output = await renderToString(<RawRequestView />, 200);

    expect(output).toContain('gemini');
    expect(output).toContain(body);
    expect(output).not.toContain('\n  "prompt"');
  });

  test('keeps active and completed Hook lifecycle status visible', async () => {
    const messages = [
      createProgressMessage<HookProgress>({
        toolUseID: 'tool-1',
        parentToolUseID: 'tool-1',
        data: {
          type: 'hook_progress',
          hookId: 'run-active',
          hookEvent: 'PreToolUse',
          hookName: 'Bash',
          hookSource: 'settings',
          hookType: 'command',
          command: 'printf active',
        },
      }),
      createAttachmentMessage({
        type: 'hook_execution',
        hookId: 'run-complete',
        hookName: 'Bash',
        toolUseID: 'tool-2',
        hookEvent: 'PostToolUse',
        hookSource: 'plugin:example',
        hookType: 'command',
        outcome: 'success',
        durationMs: 12,
      }),
    ];

    const output = await renderToString(<RawRequestView messages={messages} verbose />, 200);

    expect(output).toContain('Hook PreToolUse · settings · command · running…');
    expect(output).toContain('input: printf active');
    expect(output).toContain('Hook PostToolUse · plugin:example · command · success · 12ms');
  });
});
