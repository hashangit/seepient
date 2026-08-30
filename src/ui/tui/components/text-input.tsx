import { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
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

// ── paste handling ───────────────────────────────────────────────────────

// Ink strips one leading ESC from each input chunk, so a marker that began the
// terminal's paste burst arrives as '[200~' (no ESC); markers embedded later
// in the same chunk keep their ESC. Match both forms.
const PASTE_OPEN = /(?:\x1b)?\[200~/;
const PASTE_CLOSE = /(?:\x1b)?\[201~/;

// A chunk following another within this window is machine-paced (a paste
// split across stdin chunks); human typists bottom out ≈35ms between
// keystrokes, so 20ms separates machine bursts from human Enter.
const RAPID_CHUNK_MS = 20;

/** Terminals send pasted newlines as CRLF or CR — the value stores '\n'. */
function normalizeNewlines(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
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
  const inPaste = useRef(false);
  const lastChunkAt = useRef(0);
  const pendingPaste = useRef<string | null>(null);
  const pasteFlushScheduled = useRef(false);

  // Ask the terminal to wrap pastes in 200~/201~ markers (bracketed paste).
  // Only while live: overlays (disabled) keep raw-mode input as before, so
  // their own useInput handlers never see marker-wrapped chunks. Written to
  // the raw stream — useStdout().write is ignored once Ink has unmounted,
  // and this mode must be restored even during teardown.
  const { stdout } = useStdout();
  useEffect(() => {
    if (disabled) return;
    stdout.write('\x1b[?2004h');
    return () => { stdout.write('\x1b[?2004l'); };
  }, [disabled, stdout]);

  useEffect(() => {
    if (selfUpdate.current) {
      selfUpdate.current = false;
      return;
    }
    setCursor(value.length); // external change → cursor to end
    // An external swap (Ctrl+C clear, history recall) must not be undone by
    // paste text still queued for its flush.
    pendingPaste.current = null;
    inPaste.current = false;
  }, [value]);

  const at = Math.min(cursor, value.length);

  const insert = (text: string): void => {
    selfUpdate.current = true;
    onChange(value.slice(0, at) + text + value.slice(at));
    setCursor(at + text.length);
  };

  // Machine-paced paste chunks can arrive faster than React commits state —
  // inserting each through the current render's closure would compound on a
  // stale value and silently drop earlier lines. Coalesce burst text and
  // insert once per scheduler turn through the freshest insert closure.
  const insertRef = useRef(insert);
  insertRef.current = insert;
  const queueInsert = (text: string): void => {
    pendingPaste.current = (pendingPaste.current ?? '') + text;
    if (pasteFlushScheduled.current) return;
    pasteFlushScheduled.current = true;
    setTimeout(() => {
      pasteFlushScheduled.current = false;
      const chunk = pendingPaste.current;
      pendingPaste.current = null;
      if (chunk) insertRef.current(chunk);
    }, 0);
  };
  useEffect(() => () => {
    pendingPaste.current = null;
    pasteFlushScheduled.current = false;
  }, []);

  useInput((inputChar, key) => {
    if (disabled) return;
    const now = Date.now();
    const rapid = now - lastChunkAt.current <= RAPID_CHUNK_MS;
    lastChunkAt.current = now;
    // Bracketed paste: everything between the 200~/201~ markers is literal
    // text — embedded CR/LF insert newlines and never submit. The burst can
    // split across stdin chunks, so paste state lives in a ref. A bare Esc
    // chunk cancels a paste state that never saw its close marker (possible
    // only if pasted text itself matches the open-marker pattern).
    if (inPaste.current && key.escape) {
      inPaste.current = false;
      return;
    }
    if (inPaste.current || PASTE_OPEN.test(inputChar)) {
      const body = inPaste.current ? inputChar : inputChar.replace(PASTE_OPEN, '');
      inPaste.current = true;
      const close = PASTE_CLOSE.exec(body);
      const text = close ? body.slice(0, close.index) : body;
      if (close) inPaste.current = false;
      const normalized = normalizeNewlines(text);
      if (normalized) queueInsert(normalized);
      return;
    }
    // Unbracketed paste burst (terminal without 2004 support, or a split
    // delivery): a multi-char chunk containing CR/LF is pasted text, not
    // Enter — only a lone '\r' chunk (key.return below) submits.
    if (inputChar.length > 1 && /[\r\n]/.test(inputChar)) {
      queueInsert(normalizeNewlines(inputChar));
      return;
    }
    // Newline before submit. Ink doesn't parse the modified-return CSI a
    // terminal sends for Shift+Enter/Alt+Enter (`\x1B[27;<modifier>;13~`, where
    // 13=return); detect that raw sequence too, plus the key-flag paths + Ctrl+J.
    const isModifiedReturn = key.return && (key.shift || key.meta || key.ctrl);
    const isCtrlJ = !key.return && (inputChar === '\n' || inputChar === '\x0a' || (key.ctrl && inputChar === 'j'));
    const isModifiedReturnCSI = /\x1b?\[27;\d*;?13~/.test(inputChar);
    if (isModifiedReturn || isCtrlJ || isModifiedReturnCSI) {
      if (rapid) queueInsert('\n'); else insert('\n');
      return;
    }
    if (key.return) {
      // Terminal without bracketed-paste support: the paste burst can still
      // arrive split per line, each newline a lone CR chunk. Machine-paced
      // after the previous chunk → paste newline, not a submit.
      if (rapid) { queueInsert('\n'); return; }
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
      if (rapid) queueInsert(inputChar); else insert(inputChar);
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
