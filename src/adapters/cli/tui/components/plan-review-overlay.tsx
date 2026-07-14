/**
 * T4-5 — Plan review overlay (foundation, not full plan mode).
 */

import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../hooks/use-theme.js';

interface PlanReviewOverlayProps {
  title: string;
  steps: string[];
  onApprove: () => void;
  onReject: () => void;
}

export const PlanReviewOverlay: React.FC<PlanReviewOverlayProps> = ({ title, steps, onApprove, onReject }) => {
  const theme = useTheme();
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.purple} paddingLeft={1} paddingRight={1}>
      <Text color={theme.purple} bold>Plan: {title}</Text>
      {steps.map((step, i) => (
        <Box key={i}>
          <Text color={theme.fgDim}>{i + 1}. </Text>
          <Text>{step}</Text>
        </Box>
      ))}
      <Box marginTop={1}>
        <Text color={theme.green} bold>[Approve]</Text>
        <Text>  </Text>
        <Text color={theme.red} bold>[Reject]</Text>
      </Box>
    </Box>
  );
};
