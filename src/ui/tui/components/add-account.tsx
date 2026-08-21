/**
 * 013 T010 — shared AddAccount flow (contract model-manager-dock.md §5).
 * Searchable catalog-upstream list + pinned Custom/local path; numbered
 * credential menu; SSRF local-address affordance passed through to the
 * controller. Pure presentational component (R9). The [4] sign-in entry
 * appears only when the parent provides the M5 OAuth hooks.
 */
import React, { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { useTheme } from "../hooks/use-theme.js";
import type { AccountInput, UiError } from "../../../transport/cli/provider-manager-api.js";

export interface AddAccountProps {
  /** Derived by the parent from the catalog (distinct upstreamProvider + counts) — R1. */
  upstreams: Array<{ id: string; modelCount: number }>;
  existingIds: string[];
  prefillUpstream?: string;
  /** M5 hooks — when absent, [4] Sign in is not offered. */
  canSignIn?: (upstream: string) => boolean;
  onSignIn?: (upstream: string) => void;
  onSaveAccount: (input: AccountInput) => Promise<UiError | null>;
  onClose: () => void;
}

type Phase =
  | "choose" | "id" | "credential" | "paste" | "env"
  | "baseUrl" | "localConfirm" | "compat" | "done";

const CUSTOM_LABEL = "+ Custom / local endpoint (OpenAI-compatible, Ollama, vLLM, LM Studio…)";
const COMPAT_OPTIONS = ["none", "openai", "anthropic", "google", "openai-responses"] as const;

export function AddAccount({
  upstreams,
  existingIds,
  prefillUpstream,
  canSignIn,
  onSignIn,
  onSaveAccount,
  onClose,
}: AddAccountProps) {
  const theme = useTheme();
  const [phase, setPhase] = useState<Phase>("choose");
  const [search, setSearch] = useState(prefillUpstream ?? "");
  const [selected, setSelected] = useState(0);
  const [actionFocus, setActionFocus] = useState(false);

  const [upstream, setUpstream] = useState<string>("");       // chosen catalog upstream or "custom"
  const [accountId, setAccountId] = useState<string>("");
  const [credentialMode, setCredentialMode] = useState<"paste" | "env" | "none">("none");
  const [secret, setSecret] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [allowPrivate, setAllowPrivate] = useState(false);
  const [compatIdx, setCompatIdx] = useState(0);
  const [feedback, setFeedback] = useState<{ kind: "idle" | "busy" | "error"; message: string }>({ kind: "idle", message: "" });

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matches = upstreams.filter((u) => !q || u.id.toLowerCase().includes(q));
    return [...matches.map((u) => ({ kind: "upstream" as const, id: u.id, label: u.id, note: `${u.modelCount} models` })),
            { kind: "custom" as const, id: "custom", label: CUSTOM_LABEL, note: "" }];
  }, [upstreams, search]);

  const sel = rows[Math.min(selected, rows.length - 1)];
  const busy = feedback.kind === "busy";
  const defaultId = useMemo(() => {
    const base = upstream === "custom" ? "custom" : upstream;
    return existingIds.includes(base) ? `${base}-2` : base;
  }, [upstream, existingIds]);

  async function save(): Promise<void> {
    setFeedback({ kind: "busy", message: "Saving account…" });
    const input: AccountInput = {
      accountId: accountId || defaultId,
      upstreamProvider: upstream === "custom" ? "openai-compatible" : upstream,
      credential:
        credentialMode === "paste" ? { mode: "paste", keyValue: secret }
        : credentialMode === "env" ? { mode: "env", varName: secret }
        : { mode: "none" },
      ...(upstream === "custom" && baseUrl ? { baseUrl } : {}),
      ...(upstream === "custom" && COMPAT_OPTIONS[compatIdx] !== "none" ? { compat: COMPAT_OPTIONS[compatIdx] as any } : {}),
      ...(upstream === "custom" && allowPrivate ? { allowPrivate: true } : {}),
    };
    const err = await onSaveAccount(input);
    if (!err) setPhase("done");
    else setFeedback({ kind: "error", message: `${err.code}: ${err.message}` });
  }

  function textInput(input: string, key: any, set: (s: string) => void, next: () => void, back: () => void): void {
    if (key.escape) { back(); return; }
    if (key.return) { next(); return; }
    if (key.backspace || key.delete) { set(input.slice(0, -1)); return; }
    if (input && !key.ctrl && !key.meta && input.length >= 1 && input >= " ") set(input);
  }

  useInput((input, key) => {
    if (busy) return;
    switch (phase) {
      case "choose": {
        if (key.escape) { if (search) { setSearch(""); setSelected(0); } else onClose(); return; }
        if (actionFocus) {
          if (key.escape || key.tab || key.upArrow) { setActionFocus(false); return; }
          if (input === "1" && sel) { choose(sel.kind === "custom" ? "custom" : sel.id); return; }
          if (input === "2") { choose("custom"); return; }
          return;
        }
        if (key.tab) { setActionFocus(true); return; }
        if (key.upArrow) { setSelected((i) => Math.max(0, i - 1)); return; }
        if (key.downArrow) {
          if (selected < rows.length - 1) setSelected((i) => i + 1);
          else setActionFocus(true);
          return;
        }
        if (key.return && sel) { choose(sel.kind === "custom" ? "custom" : sel.id); return; }
        if (key.backspace || key.delete) { setSearch((s) => s.slice(0, -1)); setSelected(0); return; }
        if (input && !key.ctrl && !key.meta && input >= " ") { setSearch((s) => s + input); setSelected(0); }
        return;
      }
      case "id": {
        if (key.escape) { setPhase(upstream === "custom" ? "compat" : "choose"); return; }
        if (key.return) { setPhase("credential"); return; }
        if (key.backspace || key.delete) { setAccountId((s) => s.slice(0, -1)); return; }
        if (input && !key.ctrl && !key.meta && input >= " ") {
          setAccountId((s) => (s === "" ? input : s + input));
        }
        return;
      }
      case "credential": {
        if (key.escape) { setPhase(upstream === "custom" ? "id" : "id"); return; }
        if (input === "1") { setCredentialMode("paste"); setSecret(""); setPhase("paste"); return; }
        if (input === "2") { setCredentialMode("env"); setSecret(""); setPhase("env"); return; }
        if (input === "3") { setCredentialMode("none"); void save(); return; }
        if (input === "4" && canSignIn && onSignIn && upstream !== "custom" && canSignIn(upstream)) {
          onSignIn(upstream);
          return;
        }
        return;
      }
      case "paste":
      case "env": {
        if (key.escape) { setPhase("credential"); return; }
        if (key.return) { void save(); return; }
        if (key.backspace || key.delete) { setSecret((s) => s.slice(0, -1)); return; }
        if (input && !key.ctrl && !key.meta && input >= " ") setSecret((s) => s + input);
        return;
      }
      case "baseUrl": {
        if (key.escape) { setPhase("choose"); return; }
        if (key.return) {
          const host = baseUrl.replace(/^https?:\/\//, "");
          if (/^(localhost|127\.|0\.0\.0\.0|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(host)) {
            setPhase("localConfirm");
          } else {
            setAllowPrivate(false);
            setPhase("compat");
          }
          return;
        }
        if (key.backspace || key.delete) { setBaseUrl((s) => s.slice(0, -1)); return; }
        if (input && !key.ctrl && !key.meta && input >= " ") setBaseUrl((s) => s + input);
        return;
      }
      case "localConfirm": {
        if (key.escape) { setPhase("baseUrl"); return; }
        if (input === "1") { setAllowPrivate(true); setPhase("compat"); return; }
        if (input === "2") { setPhase("baseUrl"); return; }
        return;
      }
      case "compat": {
        if (key.escape) { setPhase("baseUrl"); return; }
        if (key.upArrow) { setCompatIdx((i) => Math.max(0, i - 1)); return; }
        if (key.downArrow) { setCompatIdx((i) => Math.min(COMPAT_OPTIONS.length - 1, i + 1)); return; }
        if (key.return) { setPhase("id"); return; }
        const n = parseInt(input ?? "", 10);
        if (!Number.isNaN(n) && n >= 1 && n <= COMPAT_OPTIONS.length) { setCompatIdx(n - 1); setPhase("id"); }
        return;
      }
      case "done": {
        if (key.escape || key.return) onClose();
        return;
      }
    }
  });

  function choose(id: string): void {
    setUpstream(id);
    setAccountId("");
    setSelected(0);
    if (id === "custom") setPhase("baseUrl");
    else setPhase("id");
  }

  // ── Renders ──────────────────────────────────────────────────────────────
  if (phase === "choose") {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.cyan} paddingLeft={1} paddingRight={1}>
        <Text color={theme.cyan} bold>Connect a provider</Text>
        <Text color={theme.fgDim}>Search providers… ({search}▏)</Text>
        {rows.map((r, i) => (
          <Text
            key={r.id}
            backgroundColor={i === selected ? theme.blue : undefined}
            color={i === selected ? theme.bg : r.kind === "custom" ? theme.yellow : theme.fg}
          >
            {i === selected ? " ▸ " : "   "}{r.label}{r.note ? ` · ${r.note}` : ""}
          </Text>
        ))}
        <Text color={actionFocus ? theme.bg : theme.fgDim} backgroundColor={actionFocus ? theme.blue : undefined}>
          {` [1] Connect provider${sel?.kind === "custom" ? " — use [2] for custom" : ""}   [2] Custom / local endpoint`}
        </Text>
        <Text color={theme.fgDim}>
          {feedback.kind === "error" ? feedback.message : "type to search · ↓ to actions · Esc back"}
        </Text>
      </Box>
    );
  }

  if (phase === "id") {
    const collides = existingIds.includes(accountId || defaultId);
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.cyan} paddingLeft={1} paddingRight={1}>
        <Text color={theme.cyan} bold>Account id</Text>
        <Text color={theme.fgDim}>A name for this connection (default: {defaultId}{collides ? " — suggested, your id already exists" : ""})</Text>
        <Text>{`> ${accountId || defaultId}▏`}</Text>
        <Text color={theme.fgDim}>Enter accept · Esc back</Text>
      </Box>
    );
  }

  if (phase === "credential") {
    const signIn = canSignIn && onSignIn && upstream !== "custom" && canSignIn(upstream);
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.cyan} paddingLeft={1} paddingRight={1}>
        <Text color={theme.cyan} bold>Credential for {accountId || defaultId} ({upstream === "custom" ? "custom endpoint" : upstream})</Text>
        <Text> [1] Paste API key (masked)</Text>
        <Text> [2] Use an environment variable</Text>
        <Text> [3] No key (keyless / local endpoint)</Text>
        {signIn ? <Text> [4] Sign in with provider</Text> : null}
        <Text color={theme.fgDim}>
          {feedback.kind === "error" ? feedback.message : "number to choose · Esc back"}
        </Text>
      </Box>
    );
  }

  if (phase === "paste" || phase === "env") {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.cyan} paddingLeft={1} paddingRight={1}>
        <Text color={theme.cyan} bold>{phase === "paste" ? "API key (masked)" : "Environment variable name"}</Text>
        <Text>{`> ${phase === "paste" ? "*".repeat(secret.length) : secret}▏`}</Text>
        {phase === "env" ? <Text color={theme.fgDim}>The variable NAME — its value is read at runtime, never stored here.</Text> : null}
        <Text color={feedback.kind === "error" ? theme.red : theme.fgDim}>
          {feedback.kind === "error" ? feedback.message : "Enter submit · Esc back"}
        </Text>
      </Box>
    );
  }

  if (phase === "baseUrl") {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.cyan} paddingLeft={1} paddingRight={1}>
        <Text color={theme.cyan} bold>Custom endpoint — Base URL</Text>
        <Text>{`> ${baseUrl}▏`}</Text>
        <Text color={theme.fgDim}>e.g. http://127.0.0.1:11434/v1 · Enter continue · Esc back</Text>
      </Box>
    );
  }

  if (phase === "localConfirm") {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.yellow} paddingLeft={1} paddingRight={1}>
        <Text color={theme.yellow}>{baseUrl} is a local/private address.</Text>
        <Text> [1] Allow local address</Text>
        <Text> [2] Cancel</Text>
      </Box>
    );
  }

  if (phase === "compat") {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.cyan} paddingLeft={1} paddingRight={1}>
        <Text color={theme.cyan} bold>Wire compatibility</Text>
        {COMPAT_OPTIONS.map((c, i) => (
          <Text key={c} backgroundColor={i === compatIdx ? theme.blue : undefined} color={i === compatIdx ? theme.bg : theme.fg}>
            {` [${i + 1}] ${c}`}
          </Text>
        ))}
        <Text color={theme.fgDim}>number or ↑/↓+Enter (default none) · Esc back</Text>
      </Box>
    );
  }

  // done
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.green} paddingLeft={1} paddingRight={1}>
      <Text color={theme.green}>✓ Account saved: {accountId || defaultId}</Text>
      <Text color={theme.fgDim}>Verify it from the Providers tab: [2] Test account.</Text>
      <Text color={theme.fgDim}>Esc back</Text>
    </Box>
  );
}
