import { feature } from 'bun:bundle';
import * as React from 'react';
import type { Command } from '../commands.js';
import { ConfigurableShortcutHint } from '../components/ConfigurableShortcutHint.js';
import { ConsoleOAuthFlow } from '../components/ConsoleOAuthFlow.js';
import type { LocalJSXCommandCall } from '../types/command.js';
import { applyConfigEnvironmentVariables } from '../utils/managedEnv.js';
import { getAPIProvider } from '../utils/model/providers.js';
import { getSettings_DEPRECATED, updateSettingsForSource } from '../utils/settings/settings.js';
import { Dialog, Text } from '@anthropic/ink';

function getEnvVarForProvider(provider: string): string {
  switch (provider) {
    case 'bedrock':
      return 'CLAUDE_CODE_USE_BEDROCK';
    case 'vertex':
      return 'CLAUDE_CODE_USE_VERTEX';
    case 'foundry':
      return 'CLAUDE_CODE_USE_FOUNDRY';
    case 'gemini':
      return 'CLAUDE_CODE_USE_GEMINI';
    case 'grok':
      return 'CLAUDE_CODE_USE_GROK';
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

// Get merged env: process.env + settings.env (from userSettings)
function getMergedEnv(): Record<string, string> {
  const settings = getSettings_DEPRECATED();
  const merged: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
  );
  if (settings?.env) {
    Object.assign(merged, settings.env);
  }
  return merged;
}

/**
 * POWER_USER: bare `/provider` opens the unified Anthropic-compatible config
 * form (Base URL / API key / model names) — same screen as /login and /model.
 * ConsoleOAuthFlow persists settings, applies env vars live, and sets the
 * main-loop model override, so the change takes effect in the current session.
 */
function ProviderConfigForm({ onDone }: { onDone: (result?: string) => void }): React.ReactNode {
  return (
    <Dialog
      title="API Provider Configuration"
      color="permission"
      onCancel={() => onDone('Kept current provider configuration')}
      inputGuide={exitState =>
        exitState.pending ? (
          <Text>Press {exitState.keyName} again to exit</Text>
        ) : (
          <ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="cancel" />
        )
      }
    >
      <ConsoleOAuthFlow
        initialMethod="custom_platform"
        onDone={() => onDone(`API provider configuration saved · current provider: ${getAPIProvider()}`)}
      />
    </Dialog>
  );
}

// Note: converted from a `local` (text-result) command to `local-jsx` so the
// no-arg POWER_USER path can render the unified config form. Trade-off:
// local-jsx commands are excluded from headless slash-command support
// (main.tsx only admits `local` + supportsNonInteractive there), so
// `/provider <name>` is interactive-only now.
const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  const arg = args.trim().toLowerCase();

  // No argument: open the unified config form (POWER_USER) or show current provider
  if (!arg) {
    if (feature('POWER_USER')) {
      return <ProviderConfigForm onDone={onDone} />;
    }
    const current = getAPIProvider();
    onDone(`Current API provider: ${current}`);
    return null;
  }

  // unset - clear settings, fallback to env vars
  if (arg === 'unset') {
    updateSettingsForSource('userSettings', { modelType: undefined });
    // Also clear all provider-specific env vars to prevent conflicts
    delete process.env.CLAUDE_CODE_USE_BEDROCK;
    delete process.env.CLAUDE_CODE_USE_VERTEX;
    delete process.env.CLAUDE_CODE_USE_FOUNDRY;
    delete process.env.CLAUDE_CODE_USE_OPENAI;
    delete process.env.CLAUDE_CODE_USE_GEMINI;
    delete process.env.CLAUDE_CODE_USE_GROK;
    onDone('API provider cleared (will use environment variables).');
    return null;
  }

  // Validate provider
  const validProviders = ['anthropic', 'openai', 'gemini', 'grok', 'bedrock', 'vertex', 'foundry'];
  if (!validProviders.includes(arg)) {
    onDone(`Invalid provider: ${arg}\nValid: ${validProviders.join(', ')}`);
    return null;
  }

  // Check env vars when switching to openai (including settings.env)
  if (arg === 'openai') {
    const mergedEnv = getMergedEnv();
    const hasChatGPTAuth = mergedEnv.OPENAI_AUTH_MODE === 'chatgpt';
    const hasKey = !!mergedEnv.OPENAI_API_KEY;
    const hasUrl = !!mergedEnv.OPENAI_BASE_URL;
    if (!hasChatGPTAuth && (!hasKey || !hasUrl)) {
      updateSettingsForSource('userSettings', { modelType: 'openai' });
      const missing = [];
      if (!hasKey) missing.push('OPENAI_API_KEY');
      if (!hasUrl) missing.push('OPENAI_BASE_URL');
      onDone(
        `Switched to OpenAI provider.\nWarning: Missing env vars: ${missing.join(', ')}\nConfigure them via /login or set manually.`,
      );
      return null;
    }
  }

  // Check env vars when switching to grok (including settings.env)
  if (arg === 'grok') {
    const mergedEnv = getMergedEnv();
    const hasKey = !!(mergedEnv.GROK_API_KEY || mergedEnv.XAI_API_KEY);
    if (!hasKey) {
      updateSettingsForSource('userSettings', { modelType: 'grok' });
      onDone(
        'Switched to Grok provider.\nWarning: Missing env var: GROK_API_KEY (or XAI_API_KEY)\nConfigure it via settings.json env or set manually.',
      );
      return null;
    }
  }

  // Check env vars when switching to gemini (including settings.env)
  if (arg === 'gemini') {
    const mergedEnv = getMergedEnv();
    const hasKey = !!mergedEnv.GEMINI_API_KEY;
    // GEMINI_BASE_URL is optional (has default)
    if (!hasKey) {
      updateSettingsForSource('userSettings', { modelType: 'gemini' });
      onDone(
        'Switched to Gemini provider.\nWarning: Missing env var: GEMINI_API_KEY\nConfigure it via /login or set manually.',
      );
      return null;
    }
  }

  // Handle different provider types
  // - 'anthropic', 'openai', 'gemini' are stored in settings.json (persistent)
  // - 'bedrock', 'vertex', 'foundry' are env-only (do NOT touch settings.json)
  if (arg === 'anthropic' || arg === 'openai' || arg === 'gemini' || arg === 'grok') {
    // Clear any cloud provider env vars to avoid conflicts
    delete process.env.CLAUDE_CODE_USE_BEDROCK;
    delete process.env.CLAUDE_CODE_USE_VERTEX;
    delete process.env.CLAUDE_CODE_USE_FOUNDRY;
    delete process.env.CLAUDE_CODE_USE_OPENAI;
    delete process.env.CLAUDE_CODE_USE_GEMINI;
    delete process.env.CLAUDE_CODE_USE_GROK;
    // Update settings.json
    updateSettingsForSource('userSettings', { modelType: arg });
    // Ensure settings.env gets applied to process.env
    applyConfigEnvironmentVariables();
    onDone(`API provider set to ${arg}.`);
    return null;
  }

  // Cloud providers: set env vars only, do NOT touch settings.json
  delete process.env.CLAUDE_CODE_USE_OPENAI;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
  delete process.env.CLAUDE_CODE_USE_GEMINI;
  delete process.env.CLAUDE_CODE_USE_GROK;
  process.env[getEnvVarForProvider(arg)] = '1';
  // Do not modify settings.json - cloud providers controlled solely by env vars
  applyConfigEnvironmentVariables();
  onDone(`API provider set to ${arg} (via environment variable).`);
  return null;
};

const provider = {
  type: 'local-jsx',
  name: 'provider',
  description: 'Switch API provider (anthropic/openai/gemini/grok/bedrock/vertex/foundry)',
  aliases: ['api'],
  argumentHint: '[anthropic|openai|gemini|grok|bedrock|vertex|foundry|unset]',
  load: () => Promise.resolve({ call }),
} satisfies Command;

export default provider;
