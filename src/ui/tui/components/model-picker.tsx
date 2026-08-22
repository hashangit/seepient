/**
 * 013 T008 — shared ModelPicker (contract model-manager-dock.md §4).
 * Pure presentational component: data + controller ops arrive as props
 * (R9 — no domain imports). One component for the dock, the wizard, and
 * `/model [search]`. Command scheme per §0: dedicated search bar owns all
 * typing (digits included); numbered action bar reached by ↓-overflow or Tab.
 */
import React, { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { useTheme } from "../hooks/use-theme.js";
import type {
  AssignmentTarget,
  AvailableModel,
  PurposeDef,
  PurposeId,
  UiError,
} from "../../../transport/cli/provider-manager-api.js";
import type { PurposeModelMap } from "../../../foundations/schemas/provider-config.js";

const MAX_VISIBLE = 10;

export interface ModelPickerProps {
  mode: "assign";
  title: string;
  purposes: PurposeDef[];
  assignments: PurposeModelMap;
  models: AvailableModel[];
  /** Capability-gating context; omit for ungated browsing. */
  activePurpose?: PurposeId;
  prefill?: string;
  /** Wizard/guided mode hides the session-switch action. */
  canSessionSwitch?: boolean;
  /** Return null on success or a UiError to display. */
  onAssign: (target: AssignmentTarget) => Promise<UiError | null>;
  onSessionSwitch: (accountId: string, modelId: string) => void;
  onConnectProvider: (upstream: string) => void;
  onClose: () => void;
}

interface PickerRow {
  key: string;
  provider: string;
  modelId: string;
  displayName: string;
  priceLabel: string;
  contextLabel: string;
  jobBadges: string[];
  reachable: boolean;
  reachableAccounts: string[];
  capabilityOk: boolean;
  mismatchReason?: string;
  thinkingLevels: string[];
  provenance: string;
}

function priceLabel(m: AvailableModel): string {
  const p = (m as any).pricing;
  if (!p || (p.promptPerMillion == null && p.completionPerMillion == null)) return "unknown";
  return `$${(p.promptPerMillion ?? 0).toFixed(2)}/$${(p.completionPerMillion ?? 0).toFixed(2)}`;
}

function contextLabel(cw: number): string {
  if (cw >= 1_000_000) return `${+(cw / 1_000_000).toFixed(1)}M`;
  return `${Math.round(cw / 1000)}k`;
}

function provenanceLabel(p: string): string {
  switch (p) {
    case "provider-discovered": return "discovered";
    case "user-declared": return "you declared";
    case "seepient-curated": return "curated";
    default: return "catalog";
  }
}

function buildRows(
  models: AvailableModel[],
  purposes: PurposeDef[],
  assignments: PurposeModelMap,
  activePurpose?: PurposeId,
): PickerRow[] {
  const def = activePurpose ? purposes.find((p) => p.id === activePurpose) : undefined;
  const badges = new Map<string, string[]>();
  const note = (key: string, providerAccount: string, model: string) => {
    const list = badges.get(`${providerAccount}/${model}`) ?? [];
    list.push(key);
    badges.set(`${providerAccount}/${model}`, list);
  };
  const a = assignments as any;
  for (const purpose of purposes) {
    if (purpose.tiered) {
      for (const tier of ["standard", "efficient", "complex"] as const) {
        const s = a?.[purpose.id]?.[tier];
        if (s?.providerAccount && s?.model) note(`${purpose.id}·${tier}`, s.providerAccount, s.model);
      }
    } else {
      const s = a?.media?.[purpose.id.slice("media.".length)];
      if (s?.providerAccount && s?.model) note(purpose.id, s.providerAccount, s.model);
    }
  }
  const rows: PickerRow[] = models.map((m) => {
    let capabilityOk = true;
    let mismatchReason: string | undefined;
    if (def) {
      const missing = def.requires.find((r) => !m.capabilities[r]);
      if (missing) {
        capabilityOk = false;
        mismatchReason =
          missing === "vision" ? "needs image understanding"
          : missing === "imageGenerate" ? "needs image generation"
          : missing === "toolUse" ? "needs tool support"
          : `needs ${missing}`;
      }
    }
    return {
      key: `${m.upstreamProvider}:${m.id}`,
      provider: m.upstreamProvider,
      modelId: m.id,
      displayName: m.displayName,
      priceLabel: priceLabel(m),
      contextLabel: contextLabel(m.contextWindow),
      jobBadges: badges.get(`${m.reachableVia[0]}/${m.id}`) ?? badges.get(`*/${m.id}`) ?? [],
      reachable: m.reachableVia.length > 0,
      reachableAccounts: m.reachableVia,
      capabilityOk,
      mismatchReason,
      thinkingLevels: m.supportedReasoningLevels ?? ["none"],
      provenance: provenanceLabel(m.provenance),
    };
  });
  rows.sort((x, y) => {
    const xs = (x.reachable && x.capabilityOk ? 0 : 1) - (y.reachable && y.capabilityOk ? 0 : 1);
    if (xs !== 0) return xs;
    const ps = x.provider.localeCompare(y.provider);
    if (ps !== 0) return ps;
    return x.displayName.localeCompare(y.displayName);
  });
  return rows;
}

type Phase = "search" | "thinking" | "connect";
type Feedback = { kind: "idle" | "busy" | "success" | "error"; message: string; note?: string };

export function ModelPicker({
  title,
  purposes,
  assignments,
  models,
  activePurpose,
  prefill,
  canSessionSwitch = true,
  onAssign,
  onSessionSwitch,
  onConnectProvider,
  onClose,
}: ModelPickerProps) {
  const theme = useTheme();
  const [phase, setPhase] = useState<Phase>("search");
  const [search, setSearch] = useState(prefill ?? "");
  const [selected, setSelected] = useState(0);
  const [actionFocus, setActionFocus] = useState(false);
  const [reachableOnly, setReachableOnly] = useState(false);
  const [thinkingIdx, setThinkingIdx] = useState(0);
  const [feedback, setFeedback] = useState<Feedback>({ kind: "idle", message: "" });

  const allRows = useMemo(
    () => buildRows(models, purposes, assignments, activePurpose),
    [models, purposes, assignments, activePurpose],
  );
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allRows.filter((r) => {
      if (reachableOnly && !r.reachable) return false;
      if (!q) return true;
      return (
        r.provider.toLowerCase().includes(q) ||
        r.modelId.toLowerCase().includes(q) ||
        r.displayName.toLowerCase().includes(q) ||
        r.reachableAccounts.some((a) => a.toLowerCase().includes(q))
      );
    });
  }, [allRows, search, reachableOnly]);

  const sel = rows[Math.min(selected, rows.length - 1)];
  const busy = feedback.kind === "busy";

  async function doAssign(row: PickerRow, level: string): Promise<void> {
    setFeedback({ kind: "busy", message: `Saving ${title}…` });
    try {
      const err = await onAssign({
        providerAccount: row.reachableAccounts[0],
        model: row.modelId,
        thinkingLevel: level as any,
      });
      if (!err) {
        setFeedback({ kind: "success", message: "✓ assigned", note: "applies next turn" });
      } else {
        setFeedback({ kind: "error", message: `${err.code}: ${err.message}` });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setFeedback({ kind: "error", message: `failed: ${msg}` });
    }
  }

  function enterRow(row: PickerRow | undefined): void {
    if (!row) return;
    if (!row.reachable) {
      setPhase("connect");
      return;
    }
    if (!row.capabilityOk) {
      setFeedback({ kind: "error", message: `validation_failed: ${title} ${row.mismatchReason}` });
      return;
    }
    if (row.thinkingLevels.length > 1) {
      const def = row.thinkingLevels.indexOf("medium");
      setThinkingIdx(def >= 0 ? def : 0);
      setPhase("thinking");
    } else {
      void doAssign(row, row.thinkingLevels[0] ?? "none");
    }
  }

  useInput((input, key) => {
    if (busy) return;
    if (phase === "thinking" && sel) {
      if (key.escape) { setPhase("search"); return; }
      if (key.upArrow) { setThinkingIdx((i) => Math.max(0, i - 1)); return; }
      if (key.downArrow) { setThinkingIdx((i) => Math.min(sel.thinkingLevels.length - 1, i + 1)); return; }
      if (key.return) { void doAssign(sel, sel.thinkingLevels[thinkingIdx]); setPhase("search"); return; }
      const n = parseInt(input ?? "", 10);
      if (!Number.isNaN(n) && n >= 1 && n <= sel.thinkingLevels.length) {
        void doAssign(sel, sel.thinkingLevels[n - 1]);
        setPhase("search");
      }
      return;
    }
    if (phase === "connect") {
      if (key.escape) { setPhase("search"); return; }
      if (input === "1" && sel) { onConnectProvider(sel.provider); setPhase("search"); }
      return;
    }
    // search phase
    if (actionFocus) {
      if (key.escape) { setActionFocus(false); return; }
      if (key.tab) { setActionFocus(false); return; }
      if (key.upArrow) { setActionFocus(false); return; }
      if (input === "1" && sel && !sel.reachable) { onConnectProvider(sel.provider); return; }
      if (input === "2" && canSessionSwitch && sel && sel.reachable) {
        onSessionSwitch(sel.reachableAccounts[0], sel.modelId);
        return;
      }
      if (input === "3") { setReachableOnly((v) => !v); setSelected(0); return; }
      if (input && /[a-z0-9]/i.test(input)) { setActionFocus(false); setSearch((s) => s + input); }
      return;
    }
    if (key.escape) {
      if (search) { setSearch(""); setSelected(0); } else onClose();
      return;
    }
    if (key.tab) { if (rows.length > 0) setActionFocus(true); return; }
    if (key.upArrow) { setSelected((i) => Math.max(0, i - 1)); return; }
    if (key.downArrow) {
      if (selected < rows.length - 1) setSelected((i) => i + 1);
      else if (rows.length > 0) setActionFocus(true);
      return;
    }
    if (key.return) { enterRow(sel); return; }
    if (key.backspace || key.delete) { setSearch((s) => s.slice(0, -1)); setSelected(0); return; }
    if (input && !key.ctrl && !key.meta && input.length >= 1 && input >= " ") {
      setSearch((s) => s + input);
      setSelected(0);
      if (feedback.kind === "error") setFeedback({ kind: "idle", message: "" });
    }
  });

  if (rows.length === 0 && phase === "search") {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.purple} paddingLeft={1} paddingRight={1}>
        <Text color={theme.purple} bold>{title}</Text>
        <Text color={theme.fgDim}>Search models… ({search})</Text>
        <Text color={theme.fgDim}>No models match{reachableOnly ? " (reachable-only is on — [3] in actions shows all)" : ""}.</Text>
        <Text color={theme.fgDim}>type to search · Esc back</Text>
      </Box>
    );
  }

  const half = Math.floor(MAX_VISIBLE / 2);
  const start = Math.max(0, Math.min(selected - half, rows.length - MAX_VISIBLE));
  const visible = rows.slice(start, start + MAX_VISIBLE);

  if (phase === "thinking" && sel) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.purple} paddingLeft={1} paddingRight={1}>
        <Text color={theme.purple} bold>Thinking effort for {title} → {sel.reachableAccounts[0]}/{sel.modelId}</Text>
        {sel.thinkingLevels.map((lvl, i) => (
          <Text key={lvl} color={i === thinkingIdx ? theme.bg : theme.fg} backgroundColor={i === thinkingIdx ? theme.blue : undefined}>
            {` [${i + 1}] ${lvl}${lvl === "medium" ? " (default)" : ""}`}
          </Text>
        ))}
        <Text color={theme.fgDim}>number or ↑/↓+Enter · Esc back</Text>
      </Box>
    );
  }

  if (phase === "connect" && sel) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.purple} paddingLeft={1} paddingRight={1}>
        <Text color={theme.yellow}>{sel.modelId} is not connected</Text>
        <Text color={theme.fgDim}> [1] Connect {sel.provider}   Esc back</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.purple} paddingLeft={1} paddingRight={1}>
      <Text color={theme.purple} bold>{title}</Text>
      <Text color={theme.fgDim}>Search models… ({search}▏)</Text>
      {visible.map((r, i) => {
        const absIdx = start + i;
        const isSel = absIdx === selected;
        const dim = !r.reachable || !r.capabilityOk;
        let header: React.ReactNode = null;
        const prev = start + i - 1 >= 0 ? rows[start + i - 1] : undefined;
        if (!prev || prev.provider !== r.provider) {
          header = <Text color={theme.cyan}>── {r.provider}{r.reachableAccounts.length > 0 ? ` (${r.reachableAccounts.join(", ")})` : ""} ──</Text>;
        }
        return (
          <Box key={r.key} flexDirection="column">
            {header}
            <Text
              backgroundColor={isSel ? theme.blue : undefined}
              color={isSel ? theme.bg : dim ? theme.fgDim : theme.fg}
            >
              {isSel ? " ▸ " : "   "}
              {dim ? "░ " : "  "}
              {r.displayName.padEnd(24)} {r.priceLabel} per 1M · {r.contextLabel}
              {r.jobBadges.length > 0 ? `  [${r.jobBadges.join(" ")}]` : ""}
              {!r.reachable ? "  not connected" : r.mismatchReason ? `  ${r.mismatchReason}` : ""}
            </Text>
          </Box>
        );
      })}
      {sel ? (
        <Box flexDirection="column">
          <Text color={theme.fgDim}>─</Text>
          <Text color={theme.fgDim}>
            ▸ {sel.modelId} · tools {sel.capabilityOk ? "✓" : "?"} · thinking: {sel.thinkingLevels.join("·")} · {sel.provenance}
          </Text>
        </Box>
      ) : null}
      <Box>
        <Text color={actionFocus ? theme.bg : theme.fgDim} backgroundColor={actionFocus ? theme.blue : undefined}>
          {` [1] Connect provider${sel?.reachable ? " — already connected" : ""}  `}
        </Text>
        {canSessionSwitch ? (
          <Text color={actionFocus ? theme.bg : theme.fgDim} backgroundColor={actionFocus ? theme.blue : undefined}>{"[2] Try for this session  "}</Text>
        ) : null}
        <Text color={actionFocus ? theme.bg : theme.fgDim} backgroundColor={actionFocus ? theme.blue : undefined}>
          {`[3] Reachable only${reachableOnly ? " ✓" : ""}`}
        </Text>
      </Box>
      <Text color={theme.fgDim}>
        {feedback.kind === "busy" ? `Saving…`
          : feedback.kind === "success" ? `${feedback.message} — ${feedback.note ?? "applies next turn"}`
          : feedback.kind === "error" ? feedback.message
          : "type to search · ↓ to actions · Esc back"}
      </Text>
    </Box>
  );
}
