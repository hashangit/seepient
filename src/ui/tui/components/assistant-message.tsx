import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../hooks/use-theme.js';
import { Markdown } from './markdown.js';
import type { AssistantMessageEntry } from '../types.js';

/** An LLM text response entry — blue-bordered bubble with a "Seepient" header. */
export const AssistantMessage = React.memo(function AssistantMessage({ entry }: { entry: AssistantMessageEntry }) {
  const theme = useTheme();
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.blue}
      paddingLeft={1}
      paddingRight={1}
    >
      <Text color={theme.blue} bold>Seepient</Text>
      <Markdown content={entry.content} />
    </Box>
  );
});
