import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../hooks/use-theme.js';
import type { UserMessageEntry } from '../types.js';

/** A user input entry — green-bordered bubble with a "You" header. */
export const UserMessage = React.memo(function UserMessage({ entry }: { entry: UserMessageEntry }) {
  const theme = useTheme();
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.green}
      paddingLeft={1}
      paddingRight={1}
    >
      <Text color={theme.green} bold>You</Text>
      <Text color={theme.fg}>{entry.content}</Text>
    </Box>
  );
});
