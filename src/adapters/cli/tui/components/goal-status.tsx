import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../hooks/use-theme.js';

export interface Todo {
  description: string;
  status: string;
}

const GLYPHS: Record<string, string> = {
  pending: '[ ]',
  in_progress: '[~]',
  completed: '[✓]',
  blocked: '[!]',
};

/**
 * GoalStatus — renders the agent's task list as bordered feed entries with
 * status glyphs. Completed tasks are dimmed. Triggered when the agent calls
 * the `manage_todos` tool (detected in tool-call-block).
 */
export const GoalStatus = React.memo(function GoalStatus({ todos }: { todos: Todo[] }) {
  const theme = useTheme();
  const colorFor = (s: string): string =>
    s === 'completed' ? theme.green
    : s === 'in_progress' ? theme.yellow
    : s === 'blocked' ? theme.red
    : theme.fgDim;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.purple} paddingLeft={1} paddingRight={1}>
      <Text color={theme.purple} bold>Tasks</Text>
      {todos.map((t, i) => (
        <Box key={i}>
          <Text>{GLYPHS[t.status] ?? '[ ]'} </Text>
          <Text color={colorFor(t.status)} dimColor={t.status === 'completed'}>{t.description}</Text>
        </Box>
      ))}
    </Box>
  );
});
