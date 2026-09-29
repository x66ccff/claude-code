import { getPlatform, type Platform } from '../platform.js'

const MACOS_BLOCKED_INJECTION_KEYWORDS = [
  'yunke',
  'loong',
  'oneagent',
  'ali',
] as const
const MAX_DISPLAY_LENGTH = 240

export type InjectionPolicyMatch = {
  field: string
  keyword: (typeof MACOS_BLOCKED_INJECTION_KEYWORDS)[number]
}

type HookDefinition = {
  type: string
  command?: string
  prompt?: string
  url?: string
  name?: string
  statusMessage?: string
}

type HookSource = {
  source?: string
  pluginId?: string
  pluginRoot?: string
  skillRoot?: string
}

export function findBlockedMacosInjection(
  fields: Readonly<Record<string, string | undefined>>,
  platform: Platform = getPlatform(),
): InjectionPolicyMatch | null {
  if (platform !== 'macos') return null

  for (const [field, value] of Object.entries(fields)) {
    if (!value) continue
    const normalized = value.toLowerCase()
    for (const keyword of MACOS_BLOCKED_INJECTION_KEYWORDS) {
      if (normalized.includes(keyword)) return { field, keyword }
    }
  }

  return null
}

export function findBlockedMacosHook(
  hook: HookDefinition,
  source: HookSource = {},
  platform: Platform = getPlatform(),
): InjectionPolicyMatch | null {
  return findBlockedMacosInjection(
    {
      command: hook.command,
      prompt: hook.prompt,
      url: hook.url,
      name: hook.name,
      statusMessage: hook.statusMessage,
      source: source.source,
      pluginId: source.pluginId,
      pluginRoot: source.pluginRoot,
      skillRoot: source.skillRoot,
    },
    platform,
  )
}

export function sanitizeHookDisplayText(
  value: string,
  maxLength: number = MAX_DISPLAY_LENGTH,
): string {
  const sanitized = Array.from(value, character => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127 ? ' ' : character
  })
    .join('')
    .replace(/:\/\/[^\s/@]+:[^\s/@]+@/g, '://[redacted]@')
    .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(
      /\b(api[_-]?key|authorization|password|secret|token)\b\s*[:=]\s*[^\s"']+/gi,
      '$1=[redacted]',
    )
    .replace(/\s+/g, ' ')
    .trim()

  return sanitized.length > maxLength
    ? `${sanitized.slice(0, maxLength - 1)}…`
    : sanitized
}

export function formatInjectionPolicyRejection(
  match: InjectionPolicyMatch,
): string {
  return `rejected by macOS policy: ${match.field} contains "${match.keyword}"`
}
