/**
 * Tests for the session-hostname recording helpers in envUtils.ts
 * (isRecordableSessionHostname + getRecordedSessionHostname).
 *
 * NOTE: feature() is folded by Bun's transpiler at module load, so
 * mock.module('bun:bundle') cannot toggle it. Run this file twice to cover
 * both flag states:
 *   bun test src/utils/__tests__/envUtils.hostname.test.ts
 *   bun test --feature RESUME_HOSTNAME src/utils/__tests__/envUtils.hostname.test.ts
 * Expectations branch on feature('RESUME_HOSTNAME') so both runs must pass.
 */
import { feature } from 'bun:bundle'
import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import * as os from 'os'

const { isRecordableSessionHostname, getRecordedSessionHostname } =
  await import('../envUtils')

const originalPlatform = process.platform

function setPlatform(value: string): void {
  Object.defineProperty(process, 'platform', {
    value,
    configurable: true,
  })
}

let hostnameSpy: ReturnType<typeof spyOn> | undefined

function mockHostname(value: string): void {
  hostnameSpy = spyOn(os, 'hostname')
  hostnameSpy.mockReturnValue(value)
}

afterEach(() => {
  setPlatform(originalPlatform)
  hostnameSpy?.mockRestore()
  hostnameSpy = undefined
})

// ─── isRecordableSessionHostname (pure predicate, flag-independent) ───

describe('isRecordableSessionHostname', () => {
  test('accepts dsw-prefixed PAI hostnames', () => {
    expect(isRecordableSessionHostname('dsw-883935-74b9658444-624v7')).toBe(
      true,
    )
  })

  test('accepts dlc-prefixed PAI hostnames', () => {
    expect(isRecordableSessionHostname('dlc-abc123')).toBe(true)
  })

  test('is case-insensitive', () => {
    expect(isRecordableSessionHostname('DSW-x')).toBe(true)
    expect(isRecordableSessionHostname('DLC-x')).toBe(true)
  })

  test('rejects non-PAI hostnames', () => {
    expect(isRecordableSessionHostname('my-laptop')).toBe(false)
  })

  test('rejects hostnames that merely contain dsw/dlc (anchored)', () => {
    expect(isRecordableSessionHostname('xdsw-1')).toBe(false)
    expect(isRecordableSessionHostname('foo-dlc')).toBe(false)
  })

  test('rejects empty string', () => {
    expect(isRecordableSessionHostname('')).toBe(false)
  })
})

// ─── getRecordedSessionHostname (dual-state, branches on the flag) ────

describe('getRecordedSessionHostname', () => {
  test('linux dsw host: records hostname iff RESUME_HOSTNAME enabled', () => {
    setPlatform('linux')
    mockHostname('dsw-883935-74b9658444-624v7')
    if (feature('RESUME_HOSTNAME')) {
      expect(getRecordedSessionHostname()).toBe('dsw-883935-74b9658444-624v7')
    } else {
      expect(getRecordedSessionHostname()).toBeUndefined()
    }
  })

  test('linux dlc host: records hostname iff RESUME_HOSTNAME enabled', () => {
    setPlatform('linux')
    mockHostname('dlc-worker-0')
    if (feature('RESUME_HOSTNAME')) {
      expect(getRecordedSessionHostname()).toBe('dlc-worker-0')
    } else {
      expect(getRecordedSessionHostname()).toBeUndefined()
    }
  })

  test('linux non-PAI host: never records', () => {
    setPlatform('linux')
    mockHostname('my-laptop')
    expect(getRecordedSessionHostname()).toBeUndefined()
  })

  test('darwin with dsw hostname: never records (linux-only)', () => {
    setPlatform('darwin')
    mockHostname('dsw-lookalike')
    expect(getRecordedSessionHostname()).toBeUndefined()
  })
})
