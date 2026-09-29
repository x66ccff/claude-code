import { marked, type Token, type Tokens } from 'marked';
import React, { Suspense, use, useEffect, useMemo, useRef, useState } from 'react';
import { LRUCache } from 'lru-cache';
import { useSettings } from '../hooks/useSettings.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { Ansi, Box, Button, NoSelect, Text, getClipboardPath, setClipboard, useTheme } from '@anthropic/ink';
import { isFullscreenActive, isMouseClicksDisabled, isMouseTrackingEnabled } from '../utils/fullscreen.js';
import { type CliHighlight, getCliHighlightPromise } from '../utils/cliHighlight.js';
import { hashContent } from '../utils/hash.js';
import { configureMarked, formatToken } from '../utils/markdown.js';
import { stripPromptXMLTags } from '../utils/messages.js';
import { MarkdownTable } from './MarkdownTable.js';

type Props = {
  children: string;
  /** When true, render all text content as dim */
  dimColor?: boolean;
  copyable?: boolean;
};

// Module-level token cache — marked.lexer is the hot cost on virtual-scroll
// remounts (~3ms per message). useMemo doesn't survive unmount→remount, so
// scrolling back to a previously-visible message re-parses. Messages are
// immutable in history; same content → same tokens. Keyed by hash to avoid
// retaining full content strings (turn50→turn99 RSS regression, #24180).
const tokenCache = new LRUCache<string, Token[]>({ max: 500 });

// Characters that indicate markdown syntax. If none are present, skip the
// ~3ms marked.lexer call entirely — render as a single paragraph. Covers
// the majority of short assistant responses and user prompts that are
// plain sentences. Checked via indexOf (not regex) for speed.
// Single regex: matches any MD marker or ordered-list start (N. at line start).
// One pass instead of 10× includes scans.
const MD_SYNTAX_RE = /[#*`|[>\-_~]|\n\n|^\d+\. |\n\d+\. /;
function hasMarkdownSyntax(s: string): boolean {
  return MD_SYNTAX_RE.test(s);
}

function cachedLexer(content: string): Token[] {
  // Fast path: plain text with no markdown syntax → single paragraph token.
  // Skips marked.lexer's full GFM parse (~3ms on long content). Not cached —
  // reconstruction is a single object allocation, and caching would retain
  // 4× content in raw/text fields plus the hash key for zero benefit.
  if (!hasMarkdownSyntax(content)) {
    return [
      {
        type: 'paragraph',
        raw: content,
        text: content,
        tokens: [{ type: 'text', raw: content, text: content }],
      } as Token,
    ];
  }
  const key = hashContent(content);
  const hit = tokenCache.get(key);
  if (hit) return hit;
  const tokens = marked.lexer(content);
  tokenCache.set(key, tokens);
  return tokens;
}

/**
 * Renders markdown content using a hybrid approach:
 * - Tables are rendered as React components with proper flexbox layout
 * - Other content is rendered as ANSI strings via formatToken
 */
export function Markdown(props: Props): React.ReactNode {
  const settings = useSettings();
  if (settings.syntaxHighlightingDisabled) {
    return <MarkdownBody {...props} highlight={null} />;
  }
  // Suspense fallback renders with highlight=null — plain markdown shows
  // for ~50ms on first ever render while cli-highlight loads.
  return (
    <Suspense fallback={<MarkdownBody {...props} highlight={null} />}>
      <MarkdownWithHighlight {...props} />
    </Suspense>
  );
}

function MarkdownWithHighlight(props: Props): React.ReactNode {
  const highlight = use(getCliHighlightPromise());
  return <MarkdownBody {...props} highlight={highlight} />;
}

function CopyableBlock({
  text,
  kind,
  children,
}: {
  text: string;
  kind: 'code' | 'table';
  children: React.ReactNode;
}): React.ReactNode {
  const [feedback, setFeedback] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const copy = async () => {
    const sequence = await setClipboard(text);
    if (sequence) process.stdout.write(sequence);
    setFeedback(getClipboardPath() === 'native' ? 'copied' : 'sent to clipboard');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setFeedback(null), 2000);
  };
  return (
    <Box flexDirection="column" width="100%">
      <Box width="100%" justifyContent="flex-end" onClick={event => event.stopImmediatePropagation()}>
        <NoSelect>
          <Button
            tabIndex={-1}
            onAction={() => {
              void copy();
            }}
          >
            {({ hovered }) => <Text color={hovered ? 'claude' : 'inactive'}>[{feedback ?? `copy ${kind}`}]</Text>}
          </Button>
        </NoSelect>
      </Box>
      {children}
    </Box>
  );
}

function isCompleteCodeBlock(token: Tokens.Code): boolean {
  const opening = /^ {0,3}(`{3,}|~{3,})/.exec(token.raw);
  if (!opening) return true;
  const fence = opening[1]!;
  const lines = token.raw.trimEnd().split('\n');
  const closing = /^ {0,3}(`+|~+)\s*$/.exec(lines.at(-1) ?? '');
  return lines.length > 1 && closing !== null && closing[1]![0] === fence[0] && closing[1]!.length >= fence.length;
}

function MarkdownBody({
  children,
  dimColor,
  copyable,
  highlight,
}: Props & { highlight: CliHighlight | null }): React.ReactNode {
  const [theme] = useTheme();
  const { columns } = useTerminalSize();
  const showCopy = copyable && isFullscreenActive() && isMouseTrackingEnabled() && !isMouseClicksDisabled();
  configureMarked();

  const elements = useMemo(() => {
    const tokens = cachedLexer(stripPromptXMLTags(children));
    const elements: React.ReactNode[] = [];
    let nonTableContent = '';

    function flushNonTableContent(): void {
      if (nonTableContent) {
        elements.push(
          <Ansi key={elements.length} dimColor={dimColor}>
            {nonTableContent.trim()}
          </Ansi>,
        );
        nonTableContent = '';
      }
    }

    for (const token of tokens) {
      if (token.type === 'table') {
        flushNonTableContent();
        const table = <MarkdownTable token={token as Tokens.Table} highlight={highlight} />;
        elements.push(
          showCopy ? (
            <CopyableBlock key={elements.length} text={token.raw.trimEnd()} kind="table">
              {table}
            </CopyableBlock>
          ) : (
            <React.Fragment key={elements.length}>{table}</React.Fragment>
          ),
        );
      } else if (showCopy && token.type === 'code' && isCompleteCodeBlock(token as Tokens.Code)) {
        flushNonTableContent();
        elements.push(
          <CopyableBlock key={elements.length} text={(token as Tokens.Code).text} kind="code">
            <Ansi dimColor={dimColor}>{formatToken(token, theme, 0, null, null, highlight).trimEnd()}</Ansi>
          </CopyableBlock>,
        );
      } else {
        nonTableContent += formatToken(token, theme, 0, null, null, highlight);
      }
    }

    flushNonTableContent();
    return elements;
  }, [children, dimColor, highlight, theme, showCopy]);

  // Rebuild copy-enabled bounds on resize; cached descendants can retain old screen coordinates.
  return (
    <Box key={showCopy ? columns : undefined} flexDirection="column" gap={1}>
      {elements}
    </Box>
  );
}

type StreamingProps = {
  children: string;
};

/**
 * Renders markdown during streaming by splitting at the last top-level block
 * boundary: everything before is stable (memoized, never re-parsed), only the
 * final block is re-parsed per delta. marked.lexer() correctly handles
 * unclosed code fences as a single token, so block boundaries are always safe.
 *
 * The stable boundary only advances (monotonic), so ref mutation during render
 * is idempotent and safe under StrictMode double-rendering. Component unmounts
 * between turns (streamingText → null), resetting the ref.
 */
export function StreamingMarkdown({ children }: StreamingProps): React.ReactNode {
  // React Compiler: this component reads and writes stablePrefixRef.current
  // during render by design. The boundary only advances (monotonic), so
  // the ref mutation is idempotent under StrictMode double-render — but the
  // compiler can't prove that, and memoizing around the ref reads would
  // break the algorithm (stale boundary). Opt out.
  'use no memo';
  configureMarked();

  // Strip before boundary tracking so it matches <Markdown>'s stripping
  // (line 29). When a closing tag arrives, stripped(N+1) is not a prefix
  // of stripped(N), but the startsWith reset below handles that with a
  // one-time re-lex on the smaller stripped string.
  const stripped = stripPromptXMLTags(children);

  const stablePrefixRef = useRef('');

  // Reset if text was replaced (defensive; normally unmount handles this)
  if (!stripped.startsWith(stablePrefixRef.current)) {
    stablePrefixRef.current = '';
  }

  // Lex only from current boundary — O(unstable length), not O(full text)
  const boundary = stablePrefixRef.current.length;
  const tokens = marked.lexer(stripped.substring(boundary));

  // Last non-space token is the growing block; everything before is final
  let lastContentIdx = tokens.length - 1;
  while (lastContentIdx >= 0 && tokens[lastContentIdx]!.type === 'space') {
    lastContentIdx--;
  }
  let advance = 0;
  for (let i = 0; i < lastContentIdx; i++) {
    advance += tokens[i]!.raw.length;
  }
  if (advance > 0) {
    stablePrefixRef.current = stripped.substring(0, boundary + advance);
  }

  const stablePrefix = stablePrefixRef.current;
  const unstableSuffix = stripped.substring(stablePrefix.length);

  // stablePrefix is memoized inside <Markdown> via useMemo([children, ...])
  // so it never re-parses as the unstable suffix grows
  return (
    <Box flexDirection="column" gap={1}>
      {stablePrefix && <Markdown copyable>{stablePrefix}</Markdown>}
      {unstableSuffix && <Markdown>{unstableSuffix}</Markdown>}
    </Box>
  );
}
