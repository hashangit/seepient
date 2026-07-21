/**
 * T4-3 — Thinking indicator.
 *
 * Eased starburst animation (8 frames) + windowed tok/s speed badge.
 * Mounts via ChatBlock('thinking').
 */

import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../hooks/use-theme.js';

const STARBURST_FRAMES = ['⟐', '⟑', '⟒', '⟓', '⟔', '⟕', '⟖', '⟗'];

interface ThinkingIndicatorProps {
  tokensPerSecond?: number;
}

export const ThinkingIndicator: React.FC<ThinkingIndicatorProps> = ({ tokensPerSecond }) => {
  const theme = useTheme();
  const [frame, setFrame] = React.useState(0);

  React.useEffect(() => {
    const interval = setInterval(() => {
      setFrame((f) => (f + 1) % STARBURST_FRAMES.length);
    }, 120);
    return () => clearInterval(interval);
  }, []);

  return (
    <Box>
      <Text color={theme.purple}>{STARBURST_FRAMES[frame]} </Text>
      <Text color={theme.fgDim}>thinking</Text>
      {tokensPerSecond != null ? (
        <Text color={theme.fgDim}> · {tokensPerSecond.toFixed(0)} tok/s</Text>
      ) : null}
    </Box>
  );
};
