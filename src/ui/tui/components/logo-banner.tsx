import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Box, Text } from 'ink';
import figlet from 'figlet';
import { useTheme } from '../hooks/use-theme.js';
import { rainbowCellColor } from '../logo/gradient.js';

// figlet is lazy-loaded: this module only imports under the interactive TUI
// (app.tsx → message-area → here), so headless/SDK/Server never pull it in.
const WORDMARK = 'Seepient Agent';
// "ANSI Compact" = solid-block figlet font (~54 cols) — the block vibe of Delta
// Corps Priest 1 at a size that fits an 80-col terminal. Swap here for another
// figlet font (e.g. 'Small Block' = 25 cols pixelated, 'Delta Corps Priest 1' =
// ~102 cols wide). figlet has no scale option, so the font IS the size.
const FONT = 'ANSI Compact';

let VERSION = '0.5.7';
try {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const pkgPath = path.join(dir, '..', '..', '..', '..', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  if (pkg.version) VERSION = pkg.version;
} catch {
  // fallback if package.json cannot be read
}

// Render once at module load; rstrip each line to drop invisible trailing spaces.
const ART_LINES = figlet
  .textSync(WORDMARK, { font: FONT, horizontalLayout: 'default' })
  .replace(/\s+$/, '')
  .split('\n')
  .map((l) => l.replace(/\s+$/, ''));
const ROWS = ART_LINES.length;
const COLS = Math.max(...ART_LINES.map((l) => [...l].length));

/**
 * Seepient Agent logo — figlet wordmark with a Tokyo Night 45° rainbow gradient
 * (lolcat-style sweep, our palette) + a dim descriptor. Rendered as the first
 * feed entry (kind: 'logo') on a fresh session, so it scrolls away as the user
 * chats.
 */
export const LogoBanner = React.memo(function LogoBanner() {
  const theme = useTheme();
  const stops = [theme.red, theme.orange, theme.yellow, theme.green, theme.cyan, theme.blue, theme.purple];
  return (
    <Box flexDirection="column" marginBottom={1}>
      {ART_LINES.map((line, r) => (
        <Box key={r}>
          {[...line].map((ch, c) =>
            ch === ' ' ? (
              <Text key={c}> </Text>
            ) : (
              <Text key={c} color={rainbowCellColor(r, c, ROWS, COLS, stops)}>{ch}</Text>
            ),
          )}
        </Box>
      ))}
      <Text color={theme.fgDim}> by hashangit · v{VERSION}</Text>
    </Box>
  );
});
