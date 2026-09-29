import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import type { Diff, Frame } from '../frame.js'
import { emptyFrame } from '../frame.js'
import { LogUpdate } from '../log-update.js'
import {
  type Cell,
  CellWidth,
  CharPool,
  createScreen,
  HyperlinkPool,
  setCellAt,
  StylePool,
} from '../screen.js'

// Regression tests for the alt-screen scrollback-duplication fix (2026-09-18):
// in alt-screen, a full reset re-pushes the whole frame and relies on CSI 3J
// to clear the old scrollback — but terminals with alternate-screen scrollback
// (iTerm2 "Save lines to scrollback in alternate screen mode") leave the old
// copies in place, duplicating transcript blocks on every offscreen-row
// change. Alt-screen must never take the 3J re-push path: offscreen-row
// changes are dropped per-cell (stale-in-scrollback is invisible), and
// resets that still must happen degrade to a viewport-only repaint.

const ENV_KEYS = [
  'ZELLIJ',
  'ZELLIJ_SESSION_NAME',
  'TERM_PROGRAM',
  'TMUX',
  'STY',
  'WT_SESSION',
  'MSYSTEM',
  'TERM_PROGRAM_VERSION',
] as const

let savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  savedEnv = {}
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = savedEnv[key]
    }
  }
})

const WIDTH = 20
const VIEWPORT_ROWS = 5
const CONTENT_ROWS = 10

function makePools() {
  return {
    stylePool: new StylePool(),
    charPool: new CharPool(),
    hyperlinkPool: new HyperlinkPool(),
  }
}

function fillRow(
  screen: ReturnType<typeof createScreen>,
  y: number,
  ch: string,
  stylePool: StylePool,
) {
  const cell: Cell = {
    char: ch,
    styleId: stylePool.none,
    width: CellWidth.Narrow,
    hyperlink: undefined,
  }
  for (let x = 0; x < screen.width; x++) {
    setCellAt(screen, x, y, { ...cell })
  }
}

// A frame whose content (CONTENT_ROWS) overflows the viewport
// (VIEWPORT_ROWS): rows 0..(CONTENT_ROWS-VIEWPORT_ROWS-1) are in scrollback.
function makeTallFrame(ch: string): {
  frame: Frame
  pools: ReturnType<typeof makePools>
} {
  const pools = makePools()
  const screen = createScreen(
    WIDTH,
    CONTENT_ROWS,
    pools.stylePool,
    pools.charPool,
    pools.hyperlinkPool,
  )
  for (let y = 0; y < CONTENT_ROWS; y++) {
    fillRow(screen, y, ch, pools.stylePool)
  }
  const frame: Frame = {
    ...emptyFrame(
      VIEWPORT_ROWS,
      WIDTH,
      pools.stylePool,
      pools.charPool,
      pools.hyperlinkPool,
    ),
    screen,
    cursor: { x: 0, y: CONTENT_ROWS, visible: true },
  }
  return { frame, pools }
}

function newLogUpdate(stylePool: StylePool): LogUpdate {
  return new LogUpdate({ isTTY: true, stylePool })
}

function diffText(diff: Diff): string {
  return diff
    .filter(
      (p): p is { type: 'stdout'; content: string } => p.type === 'stdout',
    )
    .map(p => p.content)
    .join('')
}

describe('LogUpdate alt-screen offscreen-row changes', () => {
  test('alt-screen: offscreen-row change emits no reset and no re-push', () => {
    const prev = makeTallFrame('A')
    const next = makeTallFrame('A')
    // Mutate row 0 — deep in scrollback (viewportY >= 5). This is exactly the
    // "duration label settles on a ⎿ row that already scrolled off" case.
    fillRow(next.frame.screen, 0, 'B', next.pools.stylePool)

    const diff = newLogUpdate(prev.pools.stylePool).render(
      prev.frame,
      next.frame,
      true,
    )

    expect(diff.some(p => p.type === 'clearTerminal')).toBe(false)
    expect(diff.some(p => p.type === 'clearViewport')).toBe(false)
    // The changed row must NOT be re-written anywhere in the diff — writing it
    // would require a full-frame re-push that duplicates scrollback.
    expect(diffText(diff)).not.toContain('B')
  })

  test('non-alt: same change still triggers a reset (degraded here via TMUX)', () => {
    process.env.TMUX = '1' // canEraseScrollback() → false → clearViewport
    const prev = makeTallFrame('A')
    const next = makeTallFrame('A')
    fillRow(next.frame.screen, 0, 'B', next.pools.stylePool)

    const diff = newLogUpdate(prev.pools.stylePool).render(
      prev.frame,
      next.frame,
      false,
    )

    expect(diff.some(p => p.type === 'clearViewport')).toBe(true)
    expect(diff.some(p => p.type === 'clearTerminal')).toBe(false)
    delete process.env.TMUX
  })

  test('non-alt with 3J support: same change takes the clearTerminal path', () => {
    process.env.TERM_PROGRAM = 'vscode'
    process.env.TERM_PROGRAM_VERSION = '1.100.0'
    // env fully cleared in beforeEach → canEraseScrollback() === true
    const prev = makeTallFrame('A')
    const next = makeTallFrame('A')
    fillRow(next.frame.screen, 0, 'B', next.pools.stylePool)

    const diff = newLogUpdate(prev.pools.stylePool).render(
      prev.frame,
      next.frame,
      false,
    )

    expect(diff.some(p => p.type === 'clearTerminal')).toBe(true)
  })

  test('alt-screen: shrink-to-below-viewport repaints from row 0 without 3J', () => {
    const prev = makeTallFrame('A')
    const next = makeTallFrame('A')
    // Shrink content from 10 rows (overflow) to 3 (fits viewport): rows that
    // were in scrollback must become visible again → a repaint is required.
    const shortScreen = createScreen(
      WIDTH,
      3,
      next.pools.stylePool,
      next.pools.charPool,
      next.pools.hyperlinkPool,
    )
    for (let y = 0; y < 3; y++) {
      fillRow(shortScreen, y, 'C', next.pools.stylePool)
    }
    next.frame = {
      ...next.frame,
      screen: shortScreen,
      cursor: { x: 0, y: 3, visible: true },
    }

    const diff = newLogUpdate(prev.pools.stylePool).render(
      prev.frame,
      next.frame,
      true,
    )

    // Degraded repaint, never the 3J re-push.
    expect(diff.some(p => p.type === 'clearTerminal')).toBe(false)
    expect(diff.some(p => p.type === 'clearViewport')).toBe(true)
    // The whole (short) frame is repainted from row 0 so previously-scrolled
    // rows become visible again.
    const text = diffText(diff)
    expect(text).toContain('C')
  })

  test('alt-screen: reachable-row changes still render normally (no reset)', () => {
    const prev = makeTallFrame('A')
    const next = makeTallFrame('A')
    // Row 8 is visible (viewport shows rows 5..9): changing it must produce a
    // normal cell diff, not a reset.
    fillRow(next.frame.screen, 8, 'D', next.pools.stylePool)

    const diff = newLogUpdate(prev.pools.stylePool).render(
      prev.frame,
      next.frame,
      true,
    )

    expect(diff.some(p => p.type === 'clearTerminal')).toBe(false)
    expect(diff.some(p => p.type === 'clearViewport')).toBe(false)
    expect(diffText(diff)).toContain('D')
  })
})
