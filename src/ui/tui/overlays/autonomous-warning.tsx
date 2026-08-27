/**
 * Autonomous Mode Warning Overlay (spec 017, T030).
 *
 * Shows on first-time enablement of autonomous consent mode:
 *   - Explains what stops prompting (all in-ceiling actions run unprompted)
 *   - Explains what enforcement remains (sandbox, broker network checks, immutable denies, audit)
 *   - Once confirmed, persisted to settings (permissions.autonomousWarned)
 */
import React, { useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import { useTheme } from '../hooks/use-theme.js';

interface AutonomousWarningProps {
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

export function AutonomousWarning({ onConfirm, onCancel }: AutonomousWarningProps): React.ReactElement {
  const theme = useTheme();
  const isConfirmingRef = useRef(false);

  useInput(async (input, key) => {
    if (isConfirmingRef.current) return;
    if (key.return || input === 'y' || input === 'Y') {
      isConfirmingRef.current = true;
      try {
        await onConfirm();
      } catch {
        // Handled upstream by onConfirm
      } finally {
        isConfirmingRef.current = false;
      }
    } else if (key.escape || input === 'n' || input === 'N') {
      onCancel();
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.yellow}
      paddingX={2}
      paddingY={1}
      width={70}
    >
      <Text color={theme.yellow} bold>
        ⚠ Autonomous Mode
      </Text>
      <Box height={1} />
      <Text color={theme.fg}>
        In autonomous mode, Seepient executes in-ceiling actions without prompting for approval.
      </Text>
      <Box height={1} />
      <Text color={theme.fgDim} bold>
        Enforcement that remains fully active:
      </Text>
      <Text color={theme.fgDim}>
        • OS sandbox process containment (file and command isolation)
      </Text>
      <Text color={theme.fgDim}>
        • Network broker restrictions (private IPs and unencrypted HTTP blocked)
      </Text>
      <Text color={theme.fgDim}>
        • Immutable denies (security configuration protected)
      </Text>
      <Text color={theme.fgDim}>
        • Complete audit log of all actions
      </Text>
      <Box height={1} />
      <Box flexDirection="row">
        <Text color={theme.green} bold>
          [Enter / Y] Enable Autonomous Mode
        </Text>
        <Text color={theme.fgDim}>   </Text>
        <Text color={theme.fgDim}>
          [Esc / N] Keep Edit-Enabled
        </Text>
      </Box>
    </Box>
  );
}
