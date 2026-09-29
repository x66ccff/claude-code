import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { canEraseScrollback } from '../clearTerminal.js'

const ENV_KEYS = [
  'ZELLIJ',
  'ZELLIJ_SESSION_NAME',
  'TERM_PROGRAM',
  'TMUX',
  'STY',
] as const

let saved: Record<string, string | undefined> = {}

beforeEach(() => {
  saved = {}
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = saved[key]
    }
  }
})

describe('canEraseScrollback (non-win32 path)', () => {
  test.skipIf(process.platform === 'win32')('zellij returns false', () => {
    process.env.ZELLIJ = '1'
    expect(canEraseScrollback()).toBe(false)
    delete process.env.ZELLIJ
    process.env.ZELLIJ_SESSION_NAME = 'main'
    expect(canEraseScrollback()).toBe(false)
  })

  test.skipIf(process.platform === 'win32')(
    'macOS Terminal.app returns false (ignores CSI 3J)',
    () => {
      process.env.TERM_PROGRAM = 'Apple_Terminal'
      expect(canEraseScrollback()).toBe(false)
    },
  )

  test.skipIf(process.platform === 'win32')(
    'tmux and screen return false (conservative passthrough)',
    () => {
      process.env.TMUX = '/tmp/tmux-501/default,12345,0'
      expect(canEraseScrollback()).toBe(false)
      delete process.env.TMUX
      process.env.STY = '12345.pts-0.host'
      expect(canEraseScrollback()).toBe(false)
    },
  )

  test.skipIf(process.platform === 'win32')(
    'iTerm.app and vscode stay on the fast path',
    () => {
      process.env.TERM_PROGRAM = 'iTerm.app'
      expect(canEraseScrollback()).toBe(true)
      process.env.TERM_PROGRAM = 'vscode'
      expect(canEraseScrollback()).toBe(true)
    },
  )

  test.skipIf(process.platform === 'win32')(
    'unknown terminal defaults to true (stock behavior)',
    () => {
      expect(canEraseScrollback()).toBe(true)
    },
  )
})
