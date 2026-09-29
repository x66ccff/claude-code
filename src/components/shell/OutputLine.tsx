import * as React from 'react';
import { useMemo } from 'react';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { Ansi, Box, Text, KeyboardShortcutHint, getTheme, stringWidth, useTheme } from '@anthropic/ink';
import { useShortcutDisplay } from '../../keybindings/useShortcutDisplay.js';
import { createHyperlink } from '../../utils/hyperlink.js';

import { jsonParse, jsonStringify } from '../../utils/slowOperations.js';
import { getOutputPreview } from '../../utils/terminal.js';
import { MessageResponse, ToolDurationContext } from '../MessageResponse.js';
import { InVirtualListContext } from '../messageActions.js';
import { interpolateColor, parseRGB, toRGBColor } from '../Spinner/utils.js';
import { ToolOutputExpansionContext, useExpandShellOutput } from './ExpandShellOutputContext.js';
import { isFullscreenActive, isMouseTrackingEnabled, isMouseClicksDisabled } from '../../utils/fullscreen.js';

export function tryFormatJson(line: string): string {
  try {
    const parsed = jsonParse(line);
    const stringified = jsonStringify(parsed);

    // Check if precision was lost during JSON round-trip
    // This happens when large integers exceed Number.MAX_SAFE_INTEGER
    // We normalize both strings by removing whitespace and unnecessary
    // escapes (\/ is valid but optional in JSON) for comparison
    const normalizedOriginal = line.replace(/\\\//g, '/').replace(/\s+/g, '');
    const normalizedStringified = stringified.replace(/\s+/g, '');

    if (normalizedOriginal !== normalizedStringified) {
      // Precision loss detected - return original line unformatted
      return line;
    }

    return jsonStringify(parsed, null, 2);
  } catch {
    return line;
  }
}

const MAX_JSON_FORMAT_LENGTH = 10_000;

export function tryJsonFormatContent(content: string): string {
  if (content.length > MAX_JSON_FORMAT_LENGTH) {
    return content;
  }
  const allLines = content.split('\n');
  return allLines.map(tryFormatJson).join('\n');
}

// Match http(s) URLs inside JSON string values. Conservative: no quotes,
// no whitespace, no trailing comma/brace that'd be JSON structure.
const URL_IN_JSON = /https?:\/\/[^\s"'<>\\]+/g;

export function linkifyUrlsInText(content: string): string {
  return content.replace(URL_IN_JSON, url => createHyperlink(url));
}

export function OutputLine({
  content,
  verbose,
  isError,
  isWarning,
  linkifyUrls,
}: {
  content: string;
  verbose: boolean;
  isError?: boolean;
  isWarning?: boolean;
  linkifyUrls?: boolean;
}): React.ReactNode {
  const { columns } = useTerminalSize();
  const expandShellOutput = useExpandShellOutput();
  const inVirtualList = React.useContext(InVirtualListContext);
  const durationText = React.useContext(ToolDurationContext);
  const availableColumns = columns - (durationText ? stringWidth(durationText) + 3 : 0);
  const [themeName] = useTheme();
  const theme = getTheme(themeName);
  const expandShortcut = useShortcutDisplay('app:toggleTranscript', 'Global', 'ctrl+o');
  const expansion = React.useContext(ToolOutputExpansionContext);
  const [locallyExpanded, setLocallyExpanded] = React.useState(false);
  const expanded = expansion?.expanded ?? locallyExpanded;
  const canClick = isFullscreenActive() && isMouseTrackingEnabled() && !isMouseClicksDisabled();
  const shouldShowFull = verbose || expandShellOutput;
  const toggle = expansion?.toggle ?? (() => setLocallyExpanded(value => !value));

  const formattedContent = useMemo(() => {
    let formatted = tryJsonFormatContent(content);
    if (linkifyUrls) {
      formatted = linkifyUrlsInText(formatted);
    }
    return stripUnderlineAnsi(formatted);
  }, [content, linkifyUrls]);
  const preview = useMemo(
    () => (shouldShowFull || expanded ? null : getOutputPreview(formattedContent, availableColumns)),
    [formattedContent, shouldShowFull, expanded, availableColumns],
  );

  const color = isError ? 'error' : isWarning ? 'warning' : undefined;
  const baseColor = color ?? 'text';
  const foreground = parseRGB(theme[baseColor]);
  const inactive = parseRGB(theme.inactive);
  const rowColors = [0, 0.35, 0.7].map((amount, index) =>
    foreground && inactive
      ? toRGBColor(interpolateColor(foreground, inactive, amount))
      : index === 2
        ? ('inactive' as const)
        : baseColor,
  );

  const collapseControl =
    canClick && expanded && !expandShellOutput ? (
      <Box
        alignSelf="flex-start"
        onClick={event => {
          event.stopImmediatePropagation();
          toggle();
        }}
      >
        <Text color="inactive">[click to collapse]</Text>
      </Box>
    ) : null;

  return (
    <MessageResponse>
      <Box flexDirection="column" flexGrow={1} flexShrink={1}>
        {expanded || shouldShowFull ? (
          <>
            {collapseControl}
            <Text color={color}>
              <Ansi>{formattedContent}</Ansi>
            </Text>
            {collapseControl}
          </>
        ) : preview && preview.hiddenLines > 0 ? (
          <>
            {preview.head.map((line, index) => (
              <Text key={`head-${index}`} color={rowColors[index]}>
                <Ansi>{line || ' '}</Ansi>
              </Text>
            ))}
            <Box
              alignSelf="flex-start"
              onClick={
                canClick
                  ? event => {
                      event.stopImmediatePropagation();
                      toggle();
                    }
                  : undefined
              }
            >
              <Text dimColor>
                … {preview.approximate ? '≈' : '+'}
                {preview.hiddenLines} lines
                {canClick && ' (click to expand)'}
                {!inVirtualList && (
                  <>
                    {' '}
                    <KeyboardShortcutHint shortcut={expandShortcut} action="expand" parens />
                  </>
                )}
              </Text>
            </Box>
            {preview.tail.map((line, index) => (
              <Text key={`tail-${index}`} color={rowColors[preview.tail.length - index - 1]}>
                <Ansi>{line || ' '}</Ansi>
              </Text>
            ))}
          </>
        ) : (
          <Text color={color}>
            <Ansi>{preview ? preview.head.join('\n') : formattedContent}</Ansi>
          </Text>
        )}
      </Box>
    </MessageResponse>
  );
}

/**
 * Underline ANSI codes in particular tend to leak out for some reason. I wasn't
 * able to figure out why, or why emitting a reset ANSI code wasn't enough to
 * prevent them from leaking. I also didn't want to strip all ANSI codes with
 * stripAnsi(), because we used to do that and people complained about losing
 * all formatting. So we just strip the underline ANSI codes specifically.
 */
export function stripUnderlineAnsi(content: string): string {
  return content.replace(
    // eslint-disable-next-line no-control-regex
    // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ANSI escape code regex
    /\u001b\[([0-9]+;)*4(;[0-9]+)*m|\u001b\[4(;[0-9]+)*m|\u001b\[([0-9]+;)*4m/g,
    '',
  );
}
