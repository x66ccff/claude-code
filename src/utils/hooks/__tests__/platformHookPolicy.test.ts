import { describe, expect, test } from 'bun:test'
import { HookCommandSchema } from '../../../schemas/hooks.js'
import {
  findBlockedMacosHook,
  findBlockedMacosInjection,
  sanitizeHookDisplayText,
} from '../platformHookPolicy.js'

describe('macOS Hook injection policy', () => {
  test.each([
    'command',
    'prompt',
    'agent',
    'http',
  ] as const)('preserves the name of %s hooks during parsing', type => {
    const values = {
      command: { type, command: 'true', name: 'yunke-hook' },
      prompt: { type, prompt: 'check', name: 'yunke-hook' },
      agent: { type, prompt: 'check', name: 'yunke-hook' },
      http: { type, url: 'https://example.test', name: 'yunke-hook' },
    } as const

    const hook = HookCommandSchema().parse(values[type])
    expect(hook.name).toBe('yunke-hook')
    expect(findBlockedMacosHook(hook, {}, 'macos')).toEqual({
      field: 'name',
      keyword: 'yunke',
    })
  })

  test.each([
    ['yunke', 'yunke'],
    ['LOONG', 'loong'],
    ['OneAgent', 'oneagent'],
    ['validate', 'ali'],
  ] as const)('rejects %s as a case-insensitive substring on macOS', (value, keyword) => {
    expect(findBlockedMacosInjection({ command: value }, 'macos')).toEqual({
      field: 'command',
      keyword,
    })
  })

  test('checks Hook definitions and source metadata', () => {
    expect(
      findBlockedMacosHook(
        { type: 'command', command: 'true' },
        { pluginRoot: '/opt/Loong/plugin' },
        'macos',
      ),
    ).toEqual({ field: 'pluginRoot', keyword: 'loong' })
  })

  test.each([
    'linux',
    'wsl',
    'windows',
    'unknown',
  ] as const)('allows the same fixture on %s', platform => {
    expect(
      findBlockedMacosInjection(
        {
          name: 'yunke-plugin',
          command: '/opt/loong/oneagent-validate',
        },
        platform,
      ),
    ).toBeNull()
  })

  test('allows unrelated definitions on macOS', () => {
    expect(
      findBlockedMacosInjection(
        { name: 'formatter', command: '/opt/tools/format.sh' },
        'macos',
      ),
    ).toBeNull()
  })

  test('redacts credentials and bounds display text', () => {
    const sanitized = sanitizeHookDisplayText(
      'curl https://user:pass@example.test -H "Authorization: Bearer abc" token=secret ' +
        'x'.repeat(300),
    )

    expect(sanitized).not.toContain('user:pass')
    expect(sanitized).not.toContain('Bearer abc')
    expect(sanitized).not.toContain('token=secret')
    expect(sanitized.length).toBeLessThanOrEqual(240)
  })
})
