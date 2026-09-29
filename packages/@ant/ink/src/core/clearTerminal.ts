/**
 * Cross-platform terminal clearing with scrollback support.
 * Detects modern terminals that support ESC[3J for clearing scrollback.
 */

import {
  CURSOR_HOME,
  csi,
  ERASE_SCREEN,
  ERASE_SCROLLBACK,
} from './termio/csi.js'

// HVP (Horizontal Vertical Position) - legacy Windows cursor home
const CURSOR_HOME_WINDOWS = csi(0, 'f')

function isWindowsTerminal(): boolean {
  return process.platform === 'win32' && !!process.env.WT_SESSION
}

function isMintty(): boolean {
  // mintty 3.1.5+ sets TERM_PROGRAM to 'mintty'
  if (process.env.TERM_PROGRAM === 'mintty') {
    return true
  }
  // GitBash/MSYS2/MINGW use mintty and set MSYSTEM
  if (process.platform === 'win32' && process.env.MSYSTEM) {
    return true
  }
  return false
}

function isModernWindowsTerminal(): boolean {
  // Windows Terminal sets WT_SESSION environment variable
  if (isWindowsTerminal()) {
    return true
  }

  // VS Code integrated terminal on Windows with ConPTY support
  if (
    process.platform === 'win32' &&
    process.env.TERM_PROGRAM === 'vscode' &&
    process.env.TERM_PROGRAM_VERSION
  ) {
    return true
  }

  // mintty (GitBash/MSYS2/Cygwin) supports modern escape sequences
  if (isMintty()) {
    return true
  }

  return false
}

/**
 * [ccb mod] Whether the terminal actually honors CSI 3J (erase scrollback).
 * zellij's built-in emulator ignores 3J — the same family of CSI support
 * gaps as the margined-scroll (CSI T) issue DECSTBM_SAFE already guards
 * against. When 3J is a no-op, a "clearTerminal" full reset leaves the old
 * scrollback in place AND re-pushes the whole (possibly taller-than-viewport)
 * frame through the viewport via LF, so every reset appends another full copy
 * of the transcript history to the scrollback ("scrolling up shows tons of
 * duplicated lines"). log-update uses this to degrade full resets to a
 * viewport-only repaint on such terminals.
 */
export function canEraseScrollback(): boolean {
  if (process.platform === 'win32') {
    return isModernWindowsTerminal()
  }
  if (
    process.env.ZELLIJ !== undefined ||
    process.env.ZELLIJ_SESSION_NAME !== undefined
  ) {
    return false
  }
  // [ccb mod] macOS Terminal.app silently ignores CSI 3J (ED 3) — same
  // failure family as zellij. Without this, the stock full-reset path
  // re-pushes the whole frame via LF on every reset and duplicates the
  // transcript in scrollback. iTerm.app (TERM_PROGRAM=iTerm.app) DOES
  // support 3J and must stay on the fast path.
  if (process.env.TERM_PROGRAM === 'Apple_Terminal') {
    return false
  }
  // tmux/screen pass through 3J only in recent versions and depending on
  // the outer terminal; be conservative — the degraded viewport-only
  // repaint is strictly safer and visually equivalent.
  if (process.env.TMUX !== undefined || process.env.STY !== undefined) {
    return false
  }
  return true
}

/**
 * Returns the ANSI escape sequence to clear the terminal including scrollback.
 * Automatically detects terminal capabilities.
 */
export function getClearTerminalSequence(): string {
  if (process.platform === 'win32') {
    if (isModernWindowsTerminal()) {
      return ERASE_SCREEN + ERASE_SCROLLBACK + CURSOR_HOME
    } else {
      // Legacy Windows console - can't clear scrollback
      return ERASE_SCREEN + CURSOR_HOME_WINDOWS
    }
  }
  return ERASE_SCREEN + ERASE_SCROLLBACK + CURSOR_HOME
}

/**
 * [ccb mod] Erase the visible viewport in place (2J + home) WITHOUT touching
 * scrollback. Used by the degraded full-reset path on terminals where 3J is
 * ignored — existing scrollback stays (possibly slightly stale at the top)
 * instead of being duplicated on every reset. Mirrors getClearTerminalSequence's
 * home handling: legacy Windows conhost needs HVP (CSI 0 f), not CSI H.
 */
export function getEraseViewportSequence(): string {
  if (process.platform === 'win32' && !isModernWindowsTerminal()) {
    return ERASE_SCREEN + CURSOR_HOME_WINDOWS
  }
  return ERASE_SCREEN + CURSOR_HOME
}

/**
 * Clears the terminal screen. On supported terminals, also clears scrollback.
 */
export const clearTerminal = getClearTerminalSequence()
