import { describe, expect, test } from 'bun:test'
import {
  getApiConnectionDisplay,
  maskApiCredential,
} from '../apiConnectionDisplay.js'

describe('maskApiCredential', () => {
  test('shows only the first and last four characters of a normal key', () => {
    expect(maskApiCredential('sk-example-secret-1234')).toBe('sk-e…1234')
  })

  test('never reveals a short credential in full', () => {
    expect(maskApiCredential('abcd')).toBe('••••')
    expect(maskApiCredential('abcdef')).toBe('a…f')
  })

  test('reports an absent credential without inventing a value', () => {
    expect(maskApiCredential(undefined)).toBe('not set')
  })
})

describe('getApiConnectionDisplay', () => {
  test('uses Anthropic-compatible routing for the cloud configuration', () => {
    expect(
      getApiConnectionDisplay(
        {
          ANTHROPIC_BASE_URL: 'https://openrouter.example/api',
          ANTHROPIC_AUTH_TOKEN: 'sk-or-example-9876',
        },
        'firstParty',
      ),
    ).toEqual({
      baseUrl: 'https://openrouter.example/api',
      credentialPreview: 'sk-o…9876',
    })
  })

  test('uses OpenAI-compatible routing for the local vLLM configuration', () => {
    expect(
      getApiConnectionDisplay(
        {
          OPENAI_BASE_URL: 'http://127.0.0.1:8000/v1',
          OPENAI_API_KEY: 'local-vllm',
        },
        'openai',
      ),
    ).toEqual({
      baseUrl: 'http://127.0.0.1:8000/v1',
      credentialPreview: 'loca…vllm',
    })
  })
})
