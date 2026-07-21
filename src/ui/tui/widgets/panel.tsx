import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../hooks/use-theme.js';
import type { WidgetSpec } from './types.js';

export const PanelWidget = React.memo(function PanelWidget({ spec }: { spec: WidgetSpec }) {
  const theme = useTheme();
  const body = spec.props.body as string | string[] | undefined;
  const accent = spec.props.accent as string | undefined;
  const accentColor = accent === 'red' ? theme.red : accent === 'green' ? theme.green
    : accent === 'yellow' ? theme.yellow : accent === 'cyan' ? theme.cyan : theme.fg;

  if (!body) return <Text color="gray">(empty panel)</Text>;
  const lines = Array.isArray(body)
    ? body.map((l) => String(l ?? ''))
    : String(body).split('\n');
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => (
        <Text key={i} color={accentColor}>{line}</Text>
      ))}
    </Box>
  );
});
