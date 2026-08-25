/**
 * Seepient TUI — Model Manager Dialogs (RemoveConfirm, ThinkingEditor)
 */

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { useTheme } from "../../hooks/use-theme.js";
import type { ProviderManagerApi } from "../../../../transport/cli/provider-manager-api.js";

/** Inline numbered confirm for [1] Remove anyway / [2] Cancel. */
export function RemoveConfirm({
  accountId, api, onDone, onCancel,
}: {
  accountId: string;
  slots: string[];
  api: ProviderManagerApi;
  onDone: (msg: string, isError?: boolean) => void;
  onCancel: () => void;
}) {
  useInput((input, key) => {
    if (key.escape || input === "2") { onCancel(); return; }
    if (input === "1") {
      void api.deleteAccount(accountId, { force: true }).then((r) => {
        if (r.ok) onDone(`✓ removed ${accountId}`);
        else if ("error" in r) onDone(`Error: ${r.error.message}`, true);
        else onCancel();
      }).catch((e) => onDone(`Error: ${String(e)}`, true));
    }
  });
  return null;
}

/** Minimal numbered thinking editor (dock §2 [2] Set thinking). */
export function ThinkingEditor({
  title, levels, current, onPick, onClose,
}: {
  title: string;
  levels: string[];
  current?: string;
  onPick: (level: string) => void;
  onClose: () => void;
}) {
  const theme = useTheme();
  const [idx, setIdx] = useState(() => {
    const i = levels.indexOf(current ?? "medium");
    return i >= 0 ? i : 0;
  });
  useInput((input, key) => {
    if (key.escape) { onClose(); return; }
    if (key.upArrow) { setIdx((i) => Math.max(0, i - 1)); return; }
    if (key.downArrow) { setIdx((i) => Math.min(levels.length - 1, i + 1)); return; }
    if (key.return) { onPick(levels[idx]); return; }
    const n = parseInt(input ?? "", 10);
    if (!Number.isNaN(n) && n >= 1 && n <= levels.length) onPick(levels[n - 1]);
  });
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.purple} paddingLeft={1} paddingRight={1}>
      <Text color={theme.purple} bold>{title}</Text>
      {levels.map((lvl, i) => (
        <Text key={lvl} backgroundColor={i === idx ? theme.blue : undefined} color={i === idx ? theme.bg : lvl === current ? theme.green : theme.fg}>
          {` [${i + 1}] ${lvl}${lvl === current ? " (current)" : lvl === "medium" ? " (default)" : ""}`}
        </Text>
      ))}
      <Text color={theme.fgDim}>number or ↑/↓+Enter · Esc back</Text>
    </Box>
  );
}
