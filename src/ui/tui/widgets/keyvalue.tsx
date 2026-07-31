import React from 'react';
import { Box, Text } from 'ink';
import type { WidgetSpec } from './types.js';

interface KVEntry { label: string; value: string; }

export const KeyValueWidget = React.memo(function KeyValueWidget({ spec }: { spec: WidgetSpec }) {
  const entries = (spec.props.entries as KVEntry[] | undefined)?.filter(
    (e) => e && typeof e.label === 'string' && typeof e.value === 'string',
  );
  if (!entries || entries.length === 0) return <Text color="gray">(no entries)</Text>;

  const maxLabelLen = Math.max(...entries.map((e) => e.label.length));
  return (
    <Box flexDirection="column">
      {entries.map((e, i) => (
        <Box key={i}>
          <Text color="cyan">{e.label.padEnd(maxLabelLen)}</Text>
          <Text>{` : ${e.value}`}</Text>
        </Box>
      ))}
    </Box>
  );
});
