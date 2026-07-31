import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { useTheme } from '../hooks/use-theme.js';
import { fuzzyFilter, type Suggestion } from './autocomplete.js';

interface CommandPaletteProps {
  commands: Suggestion[];
  skills: Suggestion[];
  /** Run the selected command/skill by name (no leading slash). */
  onRun: (name: string) => void;
  onClose: () => void;
}

const MAX_VISIBLE = 8;

/**
 * Ctrl+P command palette: type to fuzzy-filter commands + skills, ↑/↓ to
 * navigate, Enter to run, Esc to close. Owns its input (the prompt is hidden
 * while the palette is open).
 */
export function CommandPalette({ commands, skills, onRun, onClose }: CommandPaletteProps) {
  const theme = useTheme();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const matches = fuzzyFilter([...commands, ...skills], query);

  useInput((input, key) => {
    if (key.escape) {
      onClose();
      return;
    }
    if (key.return) {
      const m = matches[Math.min(selected, matches.length - 1)] ?? matches[0];
      if (m) onRun(m.name);
      return;
    }
    if (key.upArrow) {
      setSelected((i) => Math.max(0, i - 1));
    } else if (key.downArrow) {
      setSelected((i) => Math.min(matches.length - 1, i + 1));
    } else if (key.backspace || key.delete) {
      setQuery((q) => q.slice(0, -1));
      setSelected(0);
    } else if (input && !key.ctrl && !key.meta && input.length >= 1 && input >= ' ') {
      setQuery((q) => q + input);
      setSelected(0);
    }
  });

  const half = Math.floor(MAX_VISIBLE / 2);
  const start = Math.max(0, Math.min(selected - half, matches.length - MAX_VISIBLE));
  const visible = matches.slice(start, start + MAX_VISIBLE);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.purple} paddingLeft={1} paddingRight={1}>
      <Box>
        <Text color={theme.purple} bold>❯ </Text>
        <Text color={theme.fg}>{query}</Text>
        <Text color={theme.fgDim}> {matches.length > 0 ? `(↑↓ select, Enter run, Esc close)` : '— no matches'}</Text>
      </Box>
      {visible.map((s, i) => {
        const sel = start + i === selected;
        return (
          <Box key={s.name}>
            <Text backgroundColor={sel ? theme.blue : undefined} color={sel ? theme.bg : theme.green}>
              {sel ? '▶ ' : '  '}{s.name}
            </Text>
            {s.description ? <Text color={theme.fgDim}> {s.description.split('\n')[0].slice(0, 40)}</Text> : null}
          </Box>
        );
      })}
      {matches.length > MAX_VISIBLE ? (
        <Text color={theme.fgDim}>  {matches.length - MAX_VISIBLE} more</Text>
      ) : null}
    </Box>
  );
}
