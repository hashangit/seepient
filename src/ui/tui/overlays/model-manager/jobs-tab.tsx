/**
 * Seepient TUI — Model Manager Jobs Tab
 */

import React from "react";
import { Box, Text } from "ink";
import { useTheme } from "../../hooks/use-theme.js";
import type { SlotRow } from "./use-manager-state.js";

export interface JobsTabProps {
  slotRows: SlotRow[];
  slotIdx: number;
  slotInfo: (row: SlotRow) => { assigned: any; flag: string; detail: string };
  fallbacks: Record<string, string>;
  tabBar: React.ReactNode;
  footer: React.ReactNode;
}

export function JobsTab({
  slotRows,
  slotIdx,
  slotInfo,
  fallbacks,
  tabBar,
  footer,
}: JobsTabProps) {
  const theme = useTheme();

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.purple} paddingLeft={1} paddingRight={1}>
      {tabBar}
      {slotRows.map((row, i) => {
        const { assigned, flag, detail } = slotInfo(row);
        const selected = i === slotIdx;
        const isHeader = row.tier === "standard" || row.tier === null;
        return (
          <Box key={row.key} flexDirection="column">
            {isHeader ? <Text bold color={theme.cyan}>{row.purpose.label}</Text> : null}
            <Text
              backgroundColor={selected ? theme.blue : undefined}
              color={selected ? theme.bg : flag === "●" ? theme.green : theme.yellow}
            >
              {`${selected ? " ▸ " : "   "}${flag} ${String(row.tier ?? "single").padEnd(10)} → ${
                assigned ? `${assigned.providerAccount}/${assigned.model}${assigned.thinkingLevel ? ` [thinking: ${assigned.thinkingLevel}]` : ""}` : ""
              }${!assigned && row.tier
                ? (fallbacks[row.key] ? `(→ falls back to ${fallbacks[row.key]})` : "(→ falls back)")
                : !assigned ? "unassigned" : ""}${detail ? ` ▲ ${detail}` : ""}`}
            </Text>
          </Box>
        );
      })}
      <Box marginTop={1}>
        <Text color={theme.fgDim}> [1] Change model   [2] Set thinking   [3] Clear slot   [4] Fallback info </Text>
      </Box>
      {footer}
    </Box>
  );
}
