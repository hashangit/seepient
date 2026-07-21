import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../hooks/use-theme.js';
import type { WidgetSpec } from './types.js';

interface StatusItem { label: string; status: string; }

const STATUS_GLYPHS: Record<string, { glyph: string; color: string }> = {
  ok: { glyph: '✓', color: 'green' },
  warn: { glyph: '!', color: 'yellow' },
  fail: { glyph: '✗', color: 'red' },
  pending: { glyph: '~', color: 'yellow' },
};

export const StatusGridWidget = React.memo(function StatusGridWidget({ spec }: { spec: WidgetSpec }) {
  const theme = useTheme();
  const items = (spec.props.items as StatusItem[] | undefined)?.filter(
    (it) => it && typeof it.label === 'string' && typeof it.status === 'string',
  );
  if (!items || items.length === 0) return <Text color="gray">(no status items)</Text>;

  const maxLen = Math.max(...items.map((it) => it.label.length));
  return (
    <Box flexDirection="column">
      {items.map((it, i) => {
        const s = STATUS_GLYPHS[it.status] ?? { glyph: '?', color: 'gray' };
        return (
          <Box key={i}>
            <Text color={s.color === 'green' ? theme.green : s.color === 'red' ? theme.red : s.color === 'yellow' ? theme.yellow : theme.fgDim}>
              {s.glyph}
            </Text>
            <Text> {it.label.padEnd(maxLen + 1)} </Text>
            <Text color={theme.fgDim}>{it.status}</Text>
          </Box>
        );
      })}
    </Box>
  );
});
