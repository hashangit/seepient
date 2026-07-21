import { Box, Text, useInput } from 'ink';
import { useTheme } from '../hooks/use-theme.js';

const KEYS: Array<[string, string]> = [
  ['Ctrl+P', 'Command palette'],
  ['Ctrl+L', 'Clear conversation'],
  ['Ctrl+O', 'Expand/collapse tool output'],
  ['Ctrl+T', 'Cycle focus: prompt ↔ widgets'],
  ['Ctrl+C', 'Abort run / exit (idle)'],
  ['Esc', 'Abort run / exit widget to prompt'],
  ['Enter', 'Send message (accepts autocomplete)'],
  ['Shift+Enter', 'New line (also Alt+Enter / Ctrl+J)'],
  ['↑ / ↓', 'Move lines (history at top/bottom edge)'],
  ['Tab', 'Accept autocomplete / cycle prompt ↔ widget'],
  ['↑/↓', 'Navigate autocomplete'],
  ['↑/↓ · Enter', 'Widget focused: cycle actions, fire'],
  ['/ + Enter', 'Run slash command'],
  ['@path', 'Insert file reference'],
];

/** Keybinding reference overlay. Esc (or ?) to close. */
export function HelpDialog({ onClose }: { onClose: () => void }) {
  const theme = useTheme();
  useInput((input, key) => {
    if (key.escape || input === '?') onClose();
  });
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.cyan} paddingLeft={1} paddingRight={1}>
      <Text color={theme.cyan} bold>Keyboard Shortcuts</Text>
      {KEYS.map(([k, desc]) => (
        <Box key={k}>
          <Text color={theme.green}>{k.padEnd(16)}</Text>
          <Text color={theme.fgDim}>{desc}</Text>
        </Box>
      ))}
      <Text color={theme.fgDim}>Esc to close</Text>
    </Box>
  );
}
