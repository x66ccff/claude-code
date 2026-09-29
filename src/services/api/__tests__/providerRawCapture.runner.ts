import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { getAnthropicClient } from '../client.js'
import { streamGeminiGenerateContent } from '../gemini/client.js'
import { getGrokClient } from '../grok/client.js'
import { getOpenAIClient } from '../openai/client.js'
import { createChatGPTResponsesStream } from '../openai/responsesAdapter.js'
import {
  clearRawRequestSnapshot,
  getRawRequestSnapshot,
} from '../rawRequestSnapshot.js'

;(
  globalThis as unknown as { MACRO: { VERSION: string; BUILD_VERSION: string } }
).MACRO = {
  VERSION: 'test',
  BUILD_VERSION: 'test',
}

const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
const originalAnthropicKey = process.env.ANTHROPIC_API_KEY
const originalOpenAIKey = process.env.OPENAI_API_KEY
const originalGrokKey = process.env.GROK_API_KEY
const tempDirs: string[] = []

function sseFetch(data = '[DONE]'): typeof fetch {
  return (async () =>
    new Response(`data: ${data}\n\n`, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })) as unknown as typeof fetch
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

beforeEach(() => clearRawRequestSnapshot())

afterEach(async () => {
  clearRawRequestSnapshot()
  restoreEnv('CLAUDE_CONFIG_DIR', originalClaudeConfigDir)
  restoreEnv('ANTHROPIC_API_KEY', originalAnthropicKey)
  restoreEnv('OPENAI_API_KEY', originalOpenAIKey)
  restoreEnv('GROK_API_KEY', originalGrokKey)
  await Promise.all(
    tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })),
  )
})

describe('provider raw request capture', () => {
  test('captures the Anthropic SDK serialized request body', async () => {
    // Auth capability detection runs before the explicit client key is used.
    // Keep this fixture independent of the developer's account and CI secrets.
    process.env.ANTHROPIC_API_KEY = 'transport-secret'
    const client = await getAnthropicClient({
      apiKey: 'transport-secret',
      maxRetries: 0,
      fetchOverride: sseFetch(),
      source: 'repl_main_thread',
      captureRawRequest: true,
    })

    await client.messages.create({
      model: 'claude-test',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'anthropic-visible' }],
      stream: true,
    })

    const snapshot = getRawRequestSnapshot()
    expect(snapshot?.provider).toBe('firstParty')
    expect(snapshot?.body).toContain('anthropic-visible')
    expect(JSON.stringify(snapshot)).not.toContain('transport-secret')
  })

  test('captures the OpenAI SDK serialized request body', async () => {
    process.env.OPENAI_API_KEY = 'transport-secret'
    const client = getOpenAIClient({
      fetchOverride: sseFetch(),
      captureRawRequest: true,
    })

    await client.chat.completions.create({
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'openai-visible' }],
      stream: true,
    })

    const snapshot = getRawRequestSnapshot()
    expect(snapshot?.provider).toBe('openai')
    expect(snapshot?.body).toContain('openai-visible')
    expect(JSON.stringify(snapshot)).not.toContain('transport-secret')
  })

  test('captures the Grok SDK serialized request body', async () => {
    process.env.GROK_API_KEY = 'transport-secret'
    const client = getGrokClient({
      fetchOverride: sseFetch(),
      captureRawRequest: true,
    })

    await client.chat.completions.create({
      model: 'grok-test',
      messages: [{ role: 'user', content: 'grok-visible' }],
      stream: true,
    })

    const snapshot = getRawRequestSnapshot()
    expect(snapshot?.provider).toBe('grok')
    expect(snapshot?.body).toContain('grok-visible')
    expect(JSON.stringify(snapshot)).not.toContain('transport-secret')
  })

  test('captures the exact Gemini body without its API key header', async () => {
    const body = {
      contents: [
        { role: 'user' as const, parts: [{ text: 'gemini-visible' }] },
      ],
    }
    const stream = streamGeminiGenerateContent({
      model: 'gemini-test',
      body,
      signal: new AbortController().signal,
      fetchOverride: sseFetch(),
      captureRawRequest: true,
    })

    await stream.next()

    const snapshot = getRawRequestSnapshot()
    expect(snapshot?.provider).toBe('gemini')
    expect(snapshot?.body).toBe(JSON.stringify(body))
  })

  test('captures the exact ChatGPT Responses body without auth metadata', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'ccb-raw-auth-'))
    tempDirs.push(configDir)
    process.env.CLAUDE_CONFIG_DIR = configDir
    await writeFile(
      join(configDir, 'openai-chatgpt-auth.json'),
      JSON.stringify({
        tokens: {
          id_token: 'dummy-id',
          access_token: 'transport-secret',
          refresh_token: 'dummy-refresh',
          account_id: 'transport-account',
        },
      }),
    )
    const request = {
      model: 'gpt-test',
      stream: true as const,
      store: false as const,
      input: [{ role: 'user', content: 'responses-visible' }],
      prompt_cache_key: 'cache-key',
    }

    await createChatGPTResponsesStream({
      request,
      signal: new AbortController().signal,
      fetchOverride: sseFetch(),
      captureRawRequest: true,
    })

    const snapshot = getRawRequestSnapshot()
    expect(snapshot?.provider).toBe('chatgpt-responses')
    expect(snapshot?.body).toBe(JSON.stringify(request))
    expect(JSON.stringify(snapshot)).not.toContain('transport-secret')
    expect(JSON.stringify(snapshot)).not.toContain('transport-account')
  })
})
