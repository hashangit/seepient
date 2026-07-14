/**
 * T4-4 — TabBar component (multi-pane foundation).
 */

import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../hooks/use-theme.js';

export interface Tab {
  id: string;
  label: string;
  active?: boolean;
}

interface TabBarProps {
  tabs: Tab[];
}

export const TabBar: React.FC<TabBarProps> = ({ tabs }) => {
  const theme = useTheme();
  return (
    <Box>
      <Text color={theme.fgGutter}>│ </Text>
      {tabs.map((tab, i) => (
        <React.Fragment key={tab.id}>
          {i > 0 ? <Text color={theme.fgGutter}> │ </Text> : null}
          <Text bold={tab.active} color={tab.active ? theme.cyan : theme.fgDim}>
            {tab.label}
          </Text>
        </React.Fragment>
      ))}
    </Box>
  );
};
