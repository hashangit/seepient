import { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { useTheme } from '../hooks/use-theme.js';

interface TextInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  placeholder?: string;
  /** When true, all input is suppressed — a widget or overlay owns the keyboard. */
  disabled?: boolean;
  /** When true, ↑/↓ are left to the parent (e.g. autocomplete dropdown nav). */
  ignoreArrows?: boolean;
  /** When true, Enter does not submit — the parent owns it (autocomplete accept). */
  ignoreReturn?: boolean;
  /** Called when ↑ is pressed on the top line (recall previous history). */
  onHistoryUp?: () => void;
  /** Called when ↓ is pressed on the bottom line (recall next history). */
  onHistoryDown?: () => void;
}

// ── line/column math (value may contain '\n') ───────────────────────────

function lineColOf(value: string, cursor: number): { line: number; col: number } {
  let line = 0;
  let col = 0;
  for (let i = 0; i < cursor && i < value.length; i++) {
    if (value[i] === '\n') { line++; col = 0; } else { col++; }
  }
  return { line, col };
}

function lineStarts(value: string): number[] {
  const starts = [0];
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

/** Move the cursor up/down one line, keeping the column; returns the same cursor at an edge. */
function moveVertical(value: string, cursor: number, dir: 1 | -1): number {
  const starts = lineStarts(value);
  const { line, col } = lineColOf(value, cursor);
  const target = line + dir;
  if (target < 0 || target >= starts.length) return cursor;
  const targetStart = starts[target];
  const targetEnd = target < starts.length - 1 ? starts[target + 1] - 1 : value.length; // exclude '\n'
  const targetCol = Math.min(col, targetEnd - targetStart);
  return targetStart + targetCol;
}

/**
 * Multi-line controlled text input with cursor control + history.
 *
 * Newline: Shift+Enter / Alt+Enter / Ctrl+J (terminal-dependent — all three are
 * bound for max compatibility). Plain Enter submits. ↑/↓ move between lines;
 * at the top line ↑ recalls previous history, at the bottom line ↓ recalls next
 * (via onHistoryUp/Down). Tab is left to the parent.
 *
 * External value changes (history recall, post-submit clear) move the cursor to
 * the end; user keystrokes move it to the insertion point.
 */
export function TextInput({
  value, onChange, onSubmit, placeholder, disabled, ignoreArrows, ignoreReturn, onHistoryUp, onHistoryDown,
}: TextInputProps) {
  const theme = useTheme();
  const [cursor, setCursor] = useState(value.length);
  const selfUpdate = useRef(false);

  useEffect(() => {
    if (selfUpdate.current) {
      selfUpdate.current = false;
      return;
    }
    setCursor(value.length); // external change → cursor to end
  }, [value]);

  const at = Math.min(cursor, value.length);

  const insert = (text: string): void => {
    selfUpdate.current = true;
    onChange(value.slice(0, at) + text + value.slice(at));
    setCursor(at + text.length);
  };

  useInput((inputChar, key) => {
    if (disabled) return;
    // Newline before submit. Ink doesn't parse the modified-return CSI a
    // terminal sends for Shift+Enter/Alt+Enter (`\x1B[27;<modifier>;13~`, where
    // 13=return); detect that raw sequence too, plus the key-flag paths + Ctrl+J.
    const isModifiedReturn = key.return && (key.shift || key.meta || key.ctrl);
    const isCtrlJ = !key.return && (inputChar === '\n' || inputChar === '\x0a' || (key.ctrl && inputChar === 'j'));
    const isModifiedReturnCSI = /\x1b?\[27;\d*;?13~/.test(inputChar);
    if (isModifiedReturn || isCtrlJ || isModifiedReturnCSI) {
      insert('\n');
      return;
    }
    if (key.return) {
      if (!ignoreReturn) onSubmit(value);
      return;
    }
    if (key.backspace || key.delete) {
      if (at === 0) return;
      selfUpdate.current = true;
      onChange(value.slice(0, at - 1) + value.slice(at));
      setCursor(at - 1);
      return;
    }
    if (!ignoreArrows) {
      if (key.upArrow) {
        const { line } = lineColOf(value, at);
        if (line === 0) { onHistoryUp?.(); return; }
        setCursor(moveVertical(value, at, -1));
        return;
      }
      if (key.downArrow) {
        const last = lineStarts(value).length - 1;
        const { line } = lineColOf(value, at);
        if (line === last) { onHistoryDown?.(); return; }
        setCursor(moveVertical(value, at, 1));
        return;
      }
    }
    if (key.leftArrow) { setCursor(Math.max(0, at - 1)); return; }
    if (key.rightArrow) { setCursor(Math.min(value.length, at + 1)); return; }
    // Tab is handled by the parent (PromptArea: autocomplete accept or cycle
    // widget focus). Explicitly bail here so it never reaches the printable-char
    // insertion path.
    if (key.tab) return;
    // Insert printable text (multi-char = paste), but never raw CSI escape
    // sequences (e.g. leftover `\x1B[27;2;13~` from an unparsed modified key).
    const isCsi = /\x1b?\[\d[\d;]*[~A-Za-z]/.test(inputChar);
    if (inputChar && !key.ctrl && !key.meta && inputChar.length >= 1 && inputChar >= ' ' && !isCsi) {
      insert(inputChar);
    }
  });

  // Render — one <Text> per line; the cursor line shows the block cursor.
  if (value.length === 0) {
    return <Text color={theme.fgDim}>{placeholder ?? ''}</Text>;
  }
  const { line: curLine, col: curCol } = lineColOf(value, at);
  const lines = value.split('\n');
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => {
        if (i !== curLine) return <Text key={i}>{line || ' '}</Text>;
        const before = line.slice(0, curCol);
        const c = line.slice(curCol, curCol + 1);
        const after = line.slice(curCol + 1);
        return (
          <Text key={i}>
            {before}
            <Text backgroundColor={theme.fg} color={theme.bg}>{c || ' '}</Text>
            {after}
          </Text>
        );
      })}
    </Box>
  );
}
