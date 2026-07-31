/**
 * T4-7 — notify() toast via ChatBlock('custom').
 *
 * Non-feed flash notification that appears briefly and auto-disposes.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../hooks/use-theme.js';

interface ToastProps {
  message: string;
  type?: 'info' | 'success' | 'warn' | 'error';
  durationMs?: number;
  onDone: () => void;
}

export const Toast: React.FC<ToastProps> = ({ message, type = 'info', durationMs = 3000, onDone }) => {
  const theme = useTheme();
  const color = type === 'success' ? theme.green : type === 'error' ? theme.red
    : type === 'warn' ? theme.yellow : theme.cyan;

  React.useEffect(() => {
    const timer = setTimeout(onDone, durationMs);
    return () => clearTimeout(timer);
  }, [durationMs, onDone]);

  return (
    <Box>
      <Text color={color} bold>{message}</Text>
    </Box>
  );
};
