/**
 * T4-6 — TruncatedText: width-aware text helper.
 *
 * Extracted from tool-call-block's inline `truncate()` so other components
 * can share width-aware truncation.
 */

import { Text } from 'ink';
import { useTheme } from '../hooks/use-theme.js';

interface TruncatedTextProps {
  text: string;
  maxLength: number;
  /** Show a suffix when truncated (e.g. " … 120 more chars"). */
  showMoreHint?: boolean;
}

export function TruncatedText({ text, maxLength, showMoreHint }: TruncatedTextProps) {
  const theme = useTheme();
  if (text.length <= maxLength) {
    return <Text>{text}</Text>;
  }
  const shown = `${text.slice(0, maxLength)} …`;
  const remaining = text.length - maxLength;
  const suffix = showMoreHint ? ` (${remaining} more chars)` : '';
  return <Text color={theme.fgDim}>{shown}{suffix}</Text>;
}
