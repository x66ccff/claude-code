import { getAPIProvider, type APIProvider } from './model/providers.js'

type EnvLike = Record<string, string | undefined>

export type ApiConnectionDisplay = {
  baseUrl: string
  credentialPreview: string
}

const DEFAULT_BASE_URLS: Partial<Record<APIProvider, string>> = {
  firstParty: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
  grok: 'https://api.x.ai/v1',
}

/**
 * Keep enough of a credential visible to identify which account is active
 * without putting the complete secret in terminal scrollback or screenshots.
 */
export function maskApiCredential(value: string | undefined): string {
  const credential = value?.trim()
  if (!credential) return 'not set'
  if (credential.length <= 4) return '•'.repeat(credential.length)
  if (credential.length <= 8) {
    return `${credential.slice(0, 1)}…${credential.slice(-1)}`
  }
  return `${credential.slice(0, 4)}…${credential.slice(-4)}`
}

export function getApiConnectionDisplay(
  env: EnvLike = process.env,
  provider: APIProvider = getAPIProvider(),
): ApiConnectionDisplay {
  let baseUrl: string | undefined
  let credential: string | undefined

  switch (provider) {
    case 'openai':
      baseUrl = env.OPENAI_BASE_URL
      credential = env.OPENAI_API_KEY
      break
    case 'gemini':
      baseUrl = env.GEMINI_BASE_URL
      credential = env.GEMINI_API_KEY
      break
    case 'grok':
      baseUrl = env.GROK_BASE_URL
      credential = env.GROK_API_KEY || env.XAI_API_KEY
      break
    case 'bedrock':
      baseUrl = env.BEDROCK_BASE_URL || 'AWS Bedrock managed endpoint'
      credential = undefined
      break
    case 'vertex':
      baseUrl = env.VERTEX_BASE_URL || 'Google Vertex managed endpoint'
      credential = undefined
      break
    case 'foundry':
      baseUrl =
        env.ANTHROPIC_FOUNDRY_BASE_URL || 'Microsoft Foundry managed endpoint'
      credential = undefined
      break
    case 'firstParty':
      baseUrl = env.ANTHROPIC_BASE_URL
      credential = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY
      break
  }

  return {
    baseUrl: baseUrl || DEFAULT_BASE_URLS[provider] || 'managed endpoint',
    credentialPreview:
      provider === 'bedrock' || provider === 'vertex' || provider === 'foundry'
        ? 'managed credentials'
        : maskApiCredential(credential),
  }
}
