import { Box, Text } from 'ink';
import { useTheme } from '../hooks/use-theme.js';
import { Markdown } from './markdown.js';
import type { AssistantMessageEntry } from '../types.js';

/** An LLM text response entry — blue speaker token + markdown-rendered content. */
export function AssistantMessage({ entry }: { entry: AssistantMessageEntry }) {
  const theme = useTheme();
  return (
    <Box>
      <Text color={theme.blue} bold>Seepient › </Text>
      <Markdown content={entry.content} />
    </Box>
  );
}
