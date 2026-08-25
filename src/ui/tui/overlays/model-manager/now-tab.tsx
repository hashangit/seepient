/**
 * Seepient TUI — Model Manager Now Tab
 */

import React from "react";
import { Box, Text } from "ink";
import { useTheme } from "../../hooks/use-theme.js";
import type { ManagerState } from "../../../../transport/cli/provider-manager-api.js";

export interface NowTabProps {
  state: ManagerState;
  activeAccount?: string;
  activeModel?: string;
  activeThinking?: string;
  sessionNotice?: string;
  tabBar: React.ReactNode;
  footer: React.ReactNode;
}

export function NowTab({
  state,
  activeAccount,
  activeModel,
  activeThinking,
  sessionNotice,
  tabBar,
  footer,
}: NowTabProps) {
  const theme = useTheme();

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.purple} paddingLeft={1} paddingRight={1}>
      {tabBar}
      <Text>Active account: <Text bold color={theme.green}>{activeAccount ?? "—"}</Text></Text>
      <Text>Serving model:  <Text bold color={theme.green}>{activeModel ?? "—"}</Text></Text>
      <Text>Thinking level: <Text bold color={theme.purple}>{activeThinking ?? (state.assignments as any)?.text?.standard?.thinkingLevel ?? "none"}</Text></Text>
      {sessionNotice ? <Text color={theme.yellow}>Session override: {sessionNotice}</Text> : null}
      <Text color={theme.fgDim}>Config revision {state.revision} · changes apply next turn</Text>
      <Box marginTop={1}>
        <Text color={theme.fgDim}> [1] Refresh </Text>
      </Box>
      {footer}
    </Box>
  );
}
