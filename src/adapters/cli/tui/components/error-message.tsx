import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../hooks/use-theme.js';
import type { ErrorEntry } from '../types.js';

/** An error entry — red glyph + message. */
export const ErrorMessage = React.memo(function ErrorMessage({ entry }: { entry: ErrorEntry }) {
  const theme = useTheme();
  return (
    <Box>
      <Text color={theme.red} bold>✗ </Text>
      <Text color={theme.red}>{entry.message}</Text>
    </Box>
  );
});
