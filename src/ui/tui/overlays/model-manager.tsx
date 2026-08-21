/**
 * Seepient TUI — Model & Provider Manager Dock (013, rebuilt in place).
 *
 * Contracts: Implementation-Specs/013-provider-management-tui/contracts/
 * model-manager-dock.md. Three tabs (Jobs · Providers · Now) cycled with Tab;
 * every tab renders a numbered, labeled action bar (FR-025 — dock tabs have no
 * text inputs, so numbers always activate). Sub-overlays (picker, add-account,
 * thinking) own their own input per their contracts. All mutations flow
 * through the ProviderManagerApi controller (R15) and end in visible feedback
 * (R3 — silence is a bug).
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from 'ink';
import { render } from 'ink';
import { ThemeProvider, useTheme } from '../hooks/use-theme.js';
import { ModelPicker } from '../components/model-picker.js';
import { AddAccount } from '../components/add-account.js';
import type {
  ProviderManagerApi, ManagerState, PurposeId, PurposeDef, Tier,
  AssignmentTarget, UiError,
} from '../../../transport/cli/provider-manager-api.js';

export interface ModelManagerProps {
  api: ProviderManagerApi;
  activeAccount?: string;
  activeModel?: string;
  activeThinking?: string;
  sessionNotice?: string;
  prefill?: string;
  initialSignIn?: string;
  initialTab?: "jobs" | "providers" | "now";
  onClose: () => void;
}

type Tab = "jobs" | "providers" | "now";
type Overlay =
  | { kind: "picker"; purpose: PurposeId; tier: Tier | null; title: string; prefill?: string }
  | { kind: "thinking"; purpose: PurposeId; tier: Tier | null; levels: string[]; current?: string; target: AssignmentTarget }
  | { kind: "add-account"; prefill?: string }
  | { kind: "remove-confirm"; accountId: string; slots: string[] }
  | { kind: "sign-in"; upstream: string }
  | null;

interface SlotRow {
  purpose: PurposeDef;
  tier: Tier | null;
  key: string;
}

type Feedback = { kind: "idle" | "success" | "error"; message: string; note?: string };

const BADGE: Record<string, string> = {
  seepient: "🔑 stored key",
  oauth: "◐ sign-in",
  env: "ENV",
  keychain: "◈ keychain",
  externalsecret: "◈ external",
  none: "○ keyless",
};

export function ModelManager({
  api, activeAccount, activeModel, activeThinking, sessionNotice, prefill, initialSignIn, initialTab = "jobs", onClose,
}: ModelManagerProps) {
  const theme = useTheme();
  const [state, setState] = useState<ManagerState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>(initialTab);
  const [overlay, setOverlay] = useState<Overlay>(() =>
    initialSignIn
      ? { kind: "sign-in", upstream: initialSignIn }
      : prefill !== undefined
      ? { kind: "picker", purpose: "text", tier: "standard", title: "Assign text·standard", prefill }
      : null,
  );
  const [slotIdx, setSlotIdx] = useState(0);
  const [provIdx, setProvIdx] = useState(0);
  const [fallbacks, setFallbacks] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState<Feedback>({ kind: "idle", message: "" });
  const [oauthFlows, setOauthFlows] = useState<readonly string[]>([]);

  const load = useCallback(async (): Promise<void> => {
    setLoadError(null);
    try {
      const next = await api.getState();
      setState(next);
      // Fallback labels for empty tiered slots (bounded, in-memory state).
      const jobs: Array<[string, Promise<void>]> = [];
      for (const p of next.purposes) {
        if (!p.tiered) continue;
        for (const t of ["standard", "efficient", "complex"] as const) {
          const assigned = (next.assignments as any)?.[p.id]?.[t];
          const key = `${p.id}·${t}`;
          if (!assigned) {
            jobs.push([key, api.resolvePreview(p.id, t).then((r) => {
              if (!("ok" in r) || r.ok === undefined) {
                const preview = r as any;
                if (preview?.selectedTarget) {
                  setFallbacks((m) => ({ ...m, [key]: `${preview.selectedTarget.providerAccount}/${preview.selectedTarget.model}` }));
                }
              }
            }).catch(() => {})]);
          }
        }
      }
      await Promise.all(jobs.map(([, pr]) => pr));
    } catch (err: any) {
      setLoadError(String(err?.message ?? err));
    }
  }, [api]);

  useEffect(() => {
    void load();
    void api.getAvailableOAuthFlows?.().then((f) => setOauthFlows(f)).catch(() => {});
  }, [load, api]);

  // ── Derived board rows ────────────────────────────────────────────────────
  const slotRows: SlotRow[] = useMemo(() => {
    if (!state) return [];
    const rows: SlotRow[] = [];
    for (const p of state.purposes) {
      if (p.tiered) {
        for (const t of ["standard", "efficient", "complex"] as const) {
          rows.push({ purpose: p, tier: t, key: `${p.id}·${t}` });
        }
      } else {
        rows.push({ purpose: p, tier: null, key: p.id });
      }
    }
    return rows;
  }, [state]);

  const slotInfo = useCallback((row: SlotRow) => {
    if (!state) return { assigned: null as any, flag: "" as string, detail: "" };
    const a = state.assignments as any;
    const assigned = row.tier ? a?.[row.purpose.id]?.[row.tier] : a?.media?.[row.purpose.id.slice("media.".length)];
    if (!assigned) return { assigned: null, flag: "○", detail: "" };
    const model = state.models.find((m) => m.id === assigned.model && m.reachableVia.includes(assigned.providerAccount));
    if (model) {
      const missing = row.purpose.requires.find((r) => !model.capabilities[r]);
      if (missing) {
        return { assigned, flag: "▲", detail: missing === "vision" ? "needs image understanding" : `needs ${missing}` };
      }
      const levels = model.supportedReasoningLevels ?? ["none"];
      if (assigned.thinkingLevel && !levels.includes(assigned.thinkingLevel)) {
        return { assigned, flag: "▲", detail: `thinking ${assigned.thinkingLevel} unsupported` };
      }
    }
    return { assigned, flag: "●", detail: "" };
  }, [state]);

  const upstreams = useMemo(() => {
    if (!state) return [];
    const counts = new Map<string, number>();
    for (const m of state.models) counts.set(m.upstreamProvider, (counts.get(m.upstreamProvider) ?? 0) + 1);
    return [...counts.entries()].map(([id, modelCount]) => ({ id, modelCount }));
  }, [state]);

  const teasers = useMemo(() => {
    if (!state) return [];
    const configured = new Set(state.accounts.map((a) => a.upstreamProvider));
    return upstreams.filter((u) => !configured.has(u.id)).sort((x, y) => y.modelCount - x.modelCount).slice(0, 3);
  }, [state, upstreams]);

  // ── Mutations (all through the controller; visible feedback) ─────────────
  async function assign(purpose: PurposeId, tier: Tier | null, target: AssignmentTarget): Promise<UiError | null> {
    const res = await api.setAssignment(purpose, tier, target);
    if (res.ok) {
      setState(res.state);
      setFeedback({ kind: "success", message: "✓ assigned", note: "applies next turn" });
      return null;
    }
    setFeedback({ kind: "error", message: `${res.error.code}: ${res.error.message}` });
    return res.error;
  }

  // ── Input ─────────────────────────────────────────────────────────────────
  useInput((input, key) => {
    if (loadError) {
      if (input === "1") void load();
      else if (key.escape) onClose();
      return;
    }
    if (overlay) return; // sub-overlays own their input
    if (key.escape) { onClose(); return; }
    if (key.tab) {
      setTab((t) => (t === "jobs" ? "providers" : t === "providers" ? "now" : "jobs"));
      return;
    }
    if (key.upArrow) {
      if (tab === "jobs") setSlotIdx((i) => Math.max(0, i - 1));
      else if (tab === "providers") setProvIdx((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      if (tab === "jobs") setSlotIdx((i) => Math.min(slotRows.length - 1, i + 1));
      else if (tab === "providers") setProvIdx((i) => Math.min(state!.accounts.length - 1, i + 1));
      return;
    }
    const num = parseInt(input ?? "", 10);
    const isNum = !Number.isNaN(num) && input !== " " && input !== "";

    if (tab === "jobs") {
      const row = slotRows[slotIdx];
      if (!row) return;
      const openPicker = (): void =>
        setOverlay({ kind: "picker", purpose: row.purpose.id, tier: row.tier, title: `Assign ${row.key}` });
      const { assigned } = slotInfo(row);
      const model = assigned ? state?.models.find((m) => m.id === assigned.model) : undefined;
      if (key.return || (isNum && num === 1)) { openPicker(); return; }
      if (isNum && num === 2) {
        if (assigned && model) {
          setOverlay({
            kind: "thinking", purpose: row.purpose.id, tier: row.tier,
            levels: model.supportedReasoningLevels ?? ["none"],
            current: assigned.thinkingLevel, target: assigned,
          });
        } else setFeedback({ kind: "error", message: "Nothing assigned yet — use [1] Change model first." });
        return;
      }
      if (isNum && num === 3) {
        void (async () => {
          const res = await api.clearAssignment(row.purpose.id, row.tier);
          if (res.ok) { setState(res.state); setFeedback({ kind: "success", message: "✓ cleared", note: "applies next turn" }); void load(); }
          else setFeedback({ kind: "error", message: `${res.error.code}: ${res.error.message}` });
        })();
        return;
      }
      if (isNum && num === 4) {
        void api.resolvePreview(row.purpose.id, (row.tier ?? "standard") as Tier).then((r: any) => {
          if (r?.selectedTarget) {
            setFeedback({
              kind: "idle", message: `${row.key} → ${r.selectedTarget.providerAccount}/${r.selectedTarget.model} (${r.via})`,
            });
          }
        });
        return;
      }
      return;
    }

    if (tab === "providers") {
      const acct = state?.accounts[provIdx];
      if (isNum && num === 1) {
        if (acct && acct.health === "expired" && acct.credentialKind === "oauth") {
          setOverlay({ kind: "sign-in", upstream: acct.upstreamProvider });
        } else {
          setOverlay({ kind: "add-account" });
        }
        return;
      }
      if (!acct) return;
      if (isNum && num === 2) {
        void api.probeAccount(acct.id).then((r) => {
          setFeedback({
            kind: r.authValid ? "success" : "error",
            message: r.authValid
              ? `✓ ${acct.id}: auth ok${r.reachable === false ? " · endpoint unreachable" : ""}`
              : `⚠ ${acct.id}: could not authenticate`,
          });
        });
        return;
      }
      if (isNum && num === 3) {
        void api.refreshModels(acct.id).then((r) => {
          if (r.ok && r.state) {
            setState(r.state);
            setFeedback({
              kind: "success",
              message: r.discovered && r.discovered.length > 0
                ? `✓ discovered ${r.discovered.length} models for ${acct.id}`
                : `Model discovery isn't available for ${acct.upstreamProvider} yet — declare models on the account if any are missing.`,
            });
          } else if (r.error) {
            setFeedback({ kind: "error", message: `${r.error.code}: ${r.error.message}` });
          }
        });
        return;
      }
      if (isNum && num === 4) {
        void api.deleteAccount(acct.id).then((r) => {
          if (r.ok) { setState(r.state); setFeedback({ kind: "success", message: `✓ removed ${acct.id}` }); void load(); }
          else if ("blocked" in r) setOverlay({ kind: "remove-confirm", accountId: acct.id, slots: r.referencingSlots });
          else setFeedback({ kind: "error", message: `${r.error.code}: ${r.error.message}` });
        });
        return;
      }
      return;
    }

    // now tab
    if (isNum && num === 1) void load();
  });

  if (loadError) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.red} paddingLeft={1} paddingRight={1}>
        <Text color={theme.red}>Couldn't load provider state: {loadError}</Text>
        <Text color={theme.fgDim}> [1] Retry   Esc close</Text>
      </Box>
    );
  }
  if (!state) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.purple} paddingLeft={1} paddingRight={1}>
        <Text color={theme.fgDim}>Loading provider state…</Text>
      </Box>
    );
  }

  // ── Sub-overlays ──────────────────────────────────────────────────────────
  if (overlay?.kind === "picker") {
    return (
      <ModelPicker
        mode="assign"
        title={overlay.title}
        purposes={state.purposes}
        assignments={state.assignments}
        models={state.models}
        activePurpose={overlay.purpose}
        prefill={overlay.prefill}
        onAssign={(t) => assign(overlay.purpose, overlay.tier, t)}
        onSessionSwitch={(acct, mdl) => {
          try {
            api.switchSessionModel(acct, mdl);
            setFeedback({ kind: "success", message: `switched to ${acct}/${mdl}`, note: "session — not saved" });
            onClose();
          } catch (err: any) {
            setFeedback({ kind: "error", message: String(err?.message ?? err) });
            setOverlay(null);
          }
        }}
        onConnectProvider={(upstream) => setOverlay({ kind: "add-account", prefill: upstream })}
        onClose={() => setOverlay(null)}
      />
    );
  }

  if (overlay?.kind === "thinking") {
    return (
      <ThinkingEditor
        title={`Thinking for ${overlay.purpose}${overlay.tier ? `·${overlay.tier}` : ""}`}
        levels={overlay.levels}
        current={overlay.current}
        onPick={(level) => {
          void (async () => {
            const err = await assign(overlay.purpose, overlay.tier, { ...overlay.target, thinkingLevel: level as any });
            if (!err) setOverlay(null);
          })();
        }}
        onClose={() => setOverlay(null)}
      />
    );
  }

  if (overlay?.kind === "add-account") {
    return (
      <AddAccount
        upstreams={upstreams}
        existingIds={state.accounts.map((a) => a.id)}
        prefillUpstream={overlay.prefill}
        canSignIn={(u) => oauthFlows.includes(u.toLowerCase())}
        onSignIn={(u) => setOverlay({ kind: "sign-in", upstream: u })}
        onSaveAccount={async (input) => {
          const res = await api.saveAccount(input);
          if (res.ok) { setState(res.state); return null; }
          return res.error;
        }}
        onClose={() => setOverlay(null)}
      />
    );
  }

  if (overlay?.kind === "sign-in") {
    return (
      <SignInFlow
        upstream={overlay.upstream}
        api={api}
        onDone={(msg) => {
          setOverlay(null);
          setFeedback({ kind: "success", message: msg });
          void load();
        }}
        onCancel={() => setOverlay(null)}
      />
    );
  }

  if (overlay?.kind === "remove-confirm") {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.yellow} paddingLeft={1} paddingRight={1}>
        <Text color={theme.yellow}>Remove {overlay.accountId}? These slots reference it:</Text>
        {overlay.slots.map((s) => <Text key={s} color={theme.fg}>  · {s}</Text>)}
        <Text> [1] Remove anyway   [2] Cancel</Text>
        <RemoveConfirm accountId={overlay.accountId} slots={overlay.slots} api={api}
          onDone={(msg) => { setOverlay(null); setFeedback({ kind: "success", message: msg }); void load(); }}
          onCancel={() => setOverlay(null)} />
      </Box>
    );
  }

  // ── Tabs ──────────────────────────────────────────────────────────────────
  const tabBar = (
    <Box justifyContent="space-between" marginBottom={1}>
      <Box>
        <Text bold color={theme.purple}>Model &amp; Provider Manager </Text>
        <Text color={tab === "jobs" ? theme.cyan : theme.fgDim}>Jobs · </Text>
        <Text color={tab === "providers" ? theme.cyan : theme.fgDim}>Providers · </Text>
        <Text color={tab === "now" ? theme.cyan : theme.fgDim}>Now</Text>
      </Box>
      <Text color={theme.fgDim}>Tab next tab · Esc close</Text>
    </Box>
  );

  const footer = (
    <Box marginTop={1} flexDirection="column">
      <Text color={feedback.kind === "error" ? theme.red : feedback.kind === "success" ? theme.green : theme.fgDim}>
        {feedback.message
          ? `${feedback.message}${feedback.note ? ` — ${feedback.note}` : ""}`
          : "changes apply next turn"}
      </Text>
    </Box>
  );

  if (tab === "jobs") {
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

  if (tab === "providers") {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.purple} paddingLeft={1} paddingRight={1}>
        {tabBar}
        {state.accounts.map((a, i) => {
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
            {` [1] ${state.accounts[provIdx]?.health === "expired" && state.accounts[provIdx]?.credentialKind === "oauth" ? "Sign in again" : "Add provider"}   [2] Test account   [3] Refresh models   [4] Remove account `}
          </Text>
        </Box>
        {footer}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.purple} paddingLeft={1} paddingRight={1}>
      {tabBar}
      <Text>Active account: <Text bold color={theme.green}>{activeAccount ?? "—"}</Text></Text>
      <Text>Serving model:  <Text bold color={theme.green}>{activeModel ?? "—"}</Text></Text>
      <Text>Thinking level: <Text bold color={theme.purple}>{activeThinking ?? "none"}</Text></Text>
      {sessionNotice ? <Text color={theme.yellow}>Session override: {sessionNotice}</Text> : null}
      <Text color={theme.fgDim}>Config revision {state.revision} · changes apply next turn</Text>
      <Box marginTop={1}>
        <Text color={theme.fgDim}> [1] Refresh </Text>
      </Box>
      {footer}
    </Box>
  );
}

export interface SignInFlowProps {
  upstream: string;
  api: ProviderManagerApi;
  onDone: (msg: string) => void;
  onCancel: () => void;
}

export function SignInFlow({ upstream, api, onDone, onCancel }: SignInFlowProps) {
  const theme = useTheme();
  const [status, setStatus] = useState<"initiating" | "device_code" | "waiting" | "error">("initiating");
  const [deviceInfo, setDeviceInfo] = useState<{ userCode: string; verificationUrl: string; expiresInMs: number } | null>(null);
  const [browserUrl, setBrowserUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const start = useCallback(async () => {
    setStatus("initiating");
    setError(null);
    const res = await api.signInWithProvider(upstream, {
      onDeviceCode: (info) => {
        setDeviceInfo(info);
        setStatus("device_code");
      },
      onBrowserOpen: (url) => {
        setBrowserUrl(url);
        setStatus("waiting");
      },
      onWaiting: () => {
        setStatus("waiting");
      },
    });

    if (res.ok) {
      onDone(`✓ Signed in with ${upstream}`);
    } else {
      setError(res.error.message);
      setStatus("error");
    }
  }, [upstream, api, onDone]);

  useEffect(() => {
    void start();
  }, [start]);

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (status === "error") {
      if (input === "1") {
        void start();
      } else if (input === "2") {
        onCancel();
      }
    }
  });

  if (status === "error") {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.red} paddingLeft={1} paddingRight={1}>
        <Text color={theme.red} bold>Sign in with {upstream} failed</Text>
        <Text color={theme.fg}>{error}</Text>
        <Box marginTop={1}>
          <Text color={theme.fgDim}> [1] Try again   [2] Cancel (Esc) </Text>
        </Box>
      </Box>
    );
  }

  if (status === "device_code" && deviceInfo) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.cyan} paddingLeft={1} paddingRight={1}>
        <Text color={theme.cyan} bold>Sign in with {upstream}</Text>
        <Text>1. Open this URL in your browser: <Text color={theme.blue} underline>{deviceInfo.verificationUrl}</Text></Text>
        <Text>2. Enter confirmation code: <Text color={theme.yellow} bold>{deviceInfo.userCode}</Text></Text>
        <Text color={theme.fgDim}>Waiting for authorization in browser… (Esc to cancel)</Text>
      </Box>
    );
  }

  if (status === "waiting" && browserUrl) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.cyan} paddingLeft={1} paddingRight={1}>
        <Text color={theme.cyan} bold>Sign in with {upstream}</Text>
        <Text>Complete authentication in your browser: <Text color={theme.blue} underline>{browserUrl}</Text></Text>
        <Text color={theme.fgDim}>Waiting for browser callback… (Esc to cancel)</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.cyan} paddingLeft={1} paddingRight={1}>
      <Text color={theme.cyan} bold>Connecting to {upstream}…</Text>
      <Text color={theme.fgDim}>Initiating sign-in flow… (Esc to cancel)</Text>
    </Box>
  );
}

/** Inline numbered confirm for [1] Remove anyway / [2] Cancel. */
function RemoveConfirm({
  accountId, api, onDone, onCancel,
}: {
  accountId: string;
  slots: string[];
  api: ProviderManagerApi;
  onDone: (msg: string) => void;
  onCancel: () => void;
}) {
  useInput((input, key) => {
    if (key.escape || input === "2") { onCancel(); return; }
    if (input === "1") {
      void api.deleteAccount(accountId, { force: true }).then((r) => {
        if (r.ok) onDone(`✓ removed ${accountId}`);
        else onCancel();
      });
    }
  });
  return null;
}

/** Minimal numbered thinking editor (dock §2 [2] Set thinking). */
function ThinkingEditor({
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

/** Standalone runner for REPL / CLI interactive `/models` command (T029). */
export async function runModelManagerStandalone(options: {
  api?: ProviderManagerApi;
  activeAccount?: string;
  activeModel?: string;
  activeThinking?: string;
  initialTab?: "jobs" | "providers" | "now";
  onSwitchProvider?: (account: string, model?: string) => void;
} = {}): Promise<void> {
  const { getDefaultProviderRuntime } = await import("../../../domain/providers/provider-runtime.js");
  const { createProviderManagerApi } = await import("../../../transport/cli/provider-manager-api.js");
  const runtime = getDefaultProviderRuntime();
  const api = options.api ?? createProviderManagerApi(
    runtime,
    options.onSwitchProvider ? { switchProvider: options.onSwitchProvider } : undefined,
  );

  await new Promise<void>((resolve) => {
    let instance: ReturnType<typeof render>;
    instance = render(
      <ThemeProvider>
        <ModelManager
          api={api}
          activeAccount={options.activeAccount}
          activeModel={options.activeModel}
          activeThinking={options.activeThinking}
          initialTab={options.initialTab}
          onClose={() => {
            instance.unmount();
            resolve();
          }}
        />
      </ThemeProvider>,
      { exitOnCtrlC: true },
    );
  });
}

