import {
  type AnsiCode,
  ansiCodesToString,
  reduceAnsiCodesIncremental,
  tokenize,
  undoAnsiCodes,
} from '@alcalzone/ansi-tokenize'
import { stringWidth } from '@anthropic/ink'

const PREVIEW_LINES_PER_SIDE = 3
const MAX_UNFOLDED_LINES = PREVIEW_LINES_PER_SIDE * 2 + 1
// MessageResponse prefix and the parent tool-result width reduction.
const PADDING_TO_PREVENT_OVERFLOW = 10
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

type OutputPreview = {
  head: string[]
  tail: string[]
  hiddenLines: number
  approximate: boolean
}

function updateAnsiCodes(active: AnsiCode[], codes: AnsiCode[]): AnsiCode[] {
  return reduceAnsiCodesIncremental(active, codes).filter(
    code => code.code !== code.endCode,
  )
}

function wrapPreview(text: string, wrapWidth: number): string[] {
  const lines: string[] = []
  let active: AnsiCode[] = []
  let line = ''
  let width = 0
  let hasText = false
  let lastNonEmptyLine = 0

  function finishLine() {
    lines.push(line + ansiCodesToString(undoAnsiCodes(active)))
    if (hasText) lastNonEmptyLine = lines.length
    line = ansiCodesToString(active)
    width = 0
    hasText = false
  }

  for (const token of tokenize(text)) {
    if (token.type === 'ansi') {
      active = updateAnsiCodes(active, [token])
      line += token.code
    } else if (token.type === 'char') {
      if (token.value === '\n' || token.value === '\r\n') {
        finishLine()
        continue
      }
      const charWidth = token.fullWidth ? 2 : stringWidth(token.value)
      if (width > 0 && width + charWidth > wrapWidth) finishLine()
      line += token.value
      width += charWidth
      hasText ||= token.value.trim().length > 0
    }
  }
  finishLine()
  return lines.slice(0, lastNonEmptyLine)
}

export function getOutputPreview(
  content: string,
  terminalWidth: number,
): OutputPreview {
  const text = content.trimEnd()
  const wrapWidth = Math.max(terminalWidth - PADDING_TO_PREVENT_OVERFLOW, 10)
  const maxChars = PREVIEW_LINES_PER_SIDE * wrapWidth * 32

  if (text.length <= maxChars * 2) {
    const lines = wrapPreview(text, wrapWidth)
    if (lines.length <= MAX_UNFOLDED_LINES) {
      return { head: lines, tail: [], hiddenLines: 0, approximate: false }
    }
    return {
      head: lines.slice(0, PREVIEW_LINES_PER_SIDE),
      tail: lines.slice(-PREVIEW_LINES_PER_SIDE),
      hiddenLines: lines.length - PREVIEW_LINES_PER_SIDE * 2,
      approximate: false,
    }
  }

  const segments = graphemes.segment(text)
  let headEnd = segments.containing(maxChars)!.index
  let tailStart = segments.containing(text.length - maxChars)!.index
  let tailCodes: AnsiCode[] = []
  // Scan only control sequences in the omitted middle; never tokenize or wrap the full output.
  const escapes =
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI and OSC boundaries require matching control characters.
    /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b\u009c]*(?:\u0007|\u009c|\u001b\\))/g
  for (const match of text.matchAll(escapes)) {
    if (match.index >= tailStart) break
    const end = match.index + match[0].length
    if (match.index < headEnd && end > headEnd) headEnd = match.index
    if (end > tailStart) tailStart = end
    if (match[0].length <= maxChars) {
      tailCodes = updateAnsiCodes(
        tailCodes,
        tokenize(match[0]).filter(
          (token): token is AnsiCode => token.type === 'ansi',
        ),
      )
    }
  }

  const head = wrapPreview(text.slice(0, headEnd), wrapWidth).slice(
    0,
    PREVIEW_LINES_PER_SIDE,
  )
  const tail = wrapPreview(
    ansiCodesToString(tailCodes) + text.slice(tailStart),
    wrapWidth,
  ).slice(-PREVIEW_LINES_PER_SIDE)
  return {
    head,
    tail,
    hiddenLines: Math.max(
      2,
      Math.ceil(text.length / wrapWidth) - head.length - tail.length,
    ),
    approximate: true,
  }
}

// Raw-newline approximation; long single lines may still fold at the terminal width.
export function isOutputLineTruncated(content: string): boolean {
  let pos = 0
  for (let i = 0; i < MAX_UNFOLDED_LINES; i++) {
    pos = content.indexOf('\n', pos)
    if (pos === -1) return false
    pos++
  }
  return content.slice(pos).trimEnd().length > 0
}
