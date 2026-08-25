/**
 * Seepient TUI — Model Manager Providers Tab
 */

import React from "react";
import { Box, Text } from "ink";
import { useTheme } from "../../hooks/use-theme.js";
import type { ManagerState } from "../../../../transport/cli/provider-manager-api.js";
import { BADGE } from "./use-manager-state.js";

export interface ProvidersTabProps {
  accounts: ManagerState["accounts"];
  provIdx: number;
  teasers: Array<{ id: string; modelCount: number }>;
  tabBar: React.ReactNode;
  footer: React.ReactNode;
}

export function ProvidersTab({
  accounts,
  provIdx,
  teasers,
  tabBar,
  footer,
}: ProvidersTabProps) {
  const theme = useTheme();

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.purple} paddingLeft={1} paddingRight={1}>
      {tabBar}
      {accounts.map((a, i) => {
        const selected = i === provIdx;
        const badge = a.credentialKind === "env" ? `ENV ${a.credentialDetail ?? ""}` : BADGE[a.credentialKind] ?? a.credentialKind;
        return (
          <Text
            key={a.id}
            backgroundColor={selected ? theme.blue : undefined}
            color={selected ? theme.bg : a.health === "ok" ? theme.green : theme.yellow}
          >
            {`${selected ? " ▸ " : "   "}${a.health === "ok" ? "●" : a.health === "missing" ? "⚠" : "○"} ${a.id.padEnd(18)} ${a.upstreamProvider.padEnd(12)} ${badge} · ${a.health}${a.baseUrl ? ` · ${a.baseUrl}` : ""} · ${a.modelCount} models`}
          </Text>
        );
      })}
      {teasers.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.fgDim}>Not connected (press [1] to connect):</Text>
          {teasers.map((t) => (
            <Text key={t.id} color={theme.fgDim}>{`   ○ ${t.id} · ${t.modelCount} models`}</Text>
          ))}
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text color={theme.fgDim}>
          {` [1] ${accounts[provIdx]?.health === "expired" && accounts[provIdx]?.credentialKind === "oauth" ? "Sign in again" : "Add provider"}   [2] Test account   [3] Refresh models   [4] Remove account `}
        </Text>
      </Box>
      {footer}
    </Box>
  );
}
