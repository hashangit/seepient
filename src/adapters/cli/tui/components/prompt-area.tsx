import { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { useTheme } from '../hooks/use-theme.js';
import { TextInput } from './text-input.js';
import { Autocomplete, fuzzyFilter, type Suggestion } from './autocomplete.js';
import { getFileIndex } from '../file-index.js';

interface PromptAreaProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  /** Recall previous/next prompt (↑ on the top line / ↓ on the bottom line). */
  onHistoryUp?: () => void;
  onHistoryDown?: () => void;
  /** `/command` source (built-in registry). */
  commands: Suggestion[];
  /** `/<skill-name>` source. */
  skills: Suggestion[];
}

interface ActiveCompletion {
  kind: '/' | '@';
  tokenStart: number; // index in `value` where the current token begins
  query: string;      // text typed after the / or @
}

/** Inspect the input's last token; return completion context if it's `/` or `@`. */
function parseCompletion(value: string): ActiveCompletion | null {
  const tokenStart = value.lastIndexOf(' ') + 1;
  const token = value.slice(tokenStart);
  if (token.startsWith('/')) return { kind: '/', tokenStart, query: token.slice(1) };
  if (token.startsWith('@')) return { kind: '@', tokenStart, query: token.slice(1) };
  return null;
}

/**
 * Single-line input (custom TextInput) with a fuzzy autocomplete dropdown +
 * input history. Typing `/` suggests slash commands + skills; typing `@`
 * suggests project files (recursive index, fuzzy-matched). When the dropdown is
 * open, ↑/↓ navigate it; when closed, ↑/↓ recall previous prompts. Tab/Enter
 * accepts; a second Enter submits. Multi-line is P2 (PRD 19).
 */
export function PromptArea({ value, onChange, onSubmit, onHistoryUp, onHistoryDown, commands, skills }: PromptAreaProps) {
  const theme = useTheme();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [files, setFiles] = useState<string[]>(() => getFileIndex());

  const active = parseCompletion(value);

  useEffect(() => {
    setSelectedIndex(0);
    setDismissed(false);
  }, [active?.kind, active?.query]);

  useEffect(() => {
    if (active?.kind === '@') setFiles(getFileIndex());
  }, [active?.kind]);

  const matches: Suggestion[] =
    active?.kind === '/'
      ? fuzzyFilter([...commands, ...skills], active.query)
      : active?.kind === '@'
        ? fuzzyFilter(files.map((f) => ({ name: f })), active.query)
        : [];

  const showDropdown = !!active && !dismissed && matches.length > 0;

  // ↑/↓ navigate the autocomplete dropdown when it's open; otherwise the
  // TextInput owns ↑/↓ (line navigation + history at the top/bottom edge).
  useInput((inputChar, key) => {
    if (!showDropdown || !active) return;
    if (key.return || key.tab || inputChar === '\t') {
      const sel = matches[Math.min(selectedIndex, matches.length - 1)] ?? matches[0];
      if (sel) {
        const completed = (active.kind === '/' ? '/' : '@') + sel.name;
        onChange(value.slice(0, active.tokenStart) + completed + ' ');
      }
    } else if (key.upArrow) {
      setSelectedIndex((i) => Math.max(0, i - 1));
    } else if (key.downArrow) {
      setSelectedIndex((i) => Math.min(matches.length - 1, i + 1));
    } else if (key.escape) {
      setDismissed(true);
    }
  });

  return (
    <Box flexDirection="column">
      {showDropdown && active ? (
        <Autocomplete suggestions={matches} selectedIndex={selectedIndex} prefix={active.kind} />
      ) : null}
      <Box borderStyle="round" borderColor={theme.fgGutter} paddingLeft={1} paddingRight={1}>
        <Text color={theme.green} bold>› </Text>
        <TextInput
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          ignoreReturn={showDropdown}
          ignoreArrows={showDropdown}
          onHistoryUp={onHistoryUp}
          onHistoryDown={onHistoryDown}
          placeholder="Ask Seepient Agent — type / for commands, @ for files (Shift+Enter newline)"
        />
      </Box>
    </Box>
  );
}
