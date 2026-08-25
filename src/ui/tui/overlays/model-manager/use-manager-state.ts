/**
 * Seepient TUI — Model Manager State Hook & Controller Wiring
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useInput } from "ink";
import type {
  ProviderManagerApi,
  ManagerState,
  PurposeId,
  PurposeDef,
  Tier,
  AssignmentTarget,
  UiError,
} from "../../../../transport/cli/provider-manager-api.js";
import type { ModelManagerProps } from "../model-manager.js";

export type Tab = "jobs" | "providers" | "now";

export type Overlay =
  | { kind: "picker"; purpose: PurposeId; tier: Tier | null; title: string; prefill?: string }
  | { kind: "thinking"; purpose: PurposeId; tier: Tier | null; levels: string[]; current?: string; target: AssignmentTarget }
  | { kind: "add-account"; prefill?: string }
  | { kind: "remove-confirm"; accountId: string; slots: string[] }
  | { kind: "sign-in"; upstream: string }
  | null;

export interface SlotRow {
  purpose: PurposeDef;
  tier: Tier | null;
  key: string;
}

export type Feedback = { kind: "idle" | "success" | "error"; message: string; note?: string };

export const BADGE: Record<string, string> = {
  seepient: "🔑 stored key",
  oauth: "◐ sign-in",
  env: "ENV",
  keychain: "◈ keychain",
  externalsecret: "◈ external",
  none: "○ keyless",
};

export function useManagerState(props: ModelManagerProps) {
  const {
    api,
    prefill,
    initialSignIn,
    initialTab = "jobs",
    onClose,
  } = props;

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
              if (!("ok" in r && r.ok === false) && "selectedTarget" in r) {
                const preview = r as any;
                if (preview?.selectedTarget) {
                  setFallbacks((m) => ({ ...m, [key]: `${preview.selectedTarget.providerAccount}/${preview.selectedTarget.model}` }));
                }
              }
            })]);
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
  }, [load]);

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
    const targetAccount = state.accounts.find((acc) => acc.id === assigned.providerAccount);
    if (!targetAccount) {
      return { assigned, flag: "▲", detail: `account "${assigned.providerAccount}" not connected` };
    }
    if (targetAccount.health === "missing" || targetAccount.health === "expired") {
      return {
        assigned,
        flag: "▲",
        detail: targetAccount.health === "expired" ? "credential expired" : "credential missing",
      };
    }
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
    } else {
      return { assigned, flag: "▲", detail: "model unreachable" };
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
    if (!state) return;
    if (key.tab) {
      if (key.shift) {
        setTab((t) => (t === "jobs" ? "now" : t === "providers" ? "jobs" : "providers"));
      } else {
        setTab((t) => (t === "jobs" ? "providers" : t === "providers" ? "now" : "jobs"));
      }
      return;
    }
    if (key.leftArrow) {
      setTab((t) => (t === "jobs" ? "now" : t === "providers" ? "jobs" : "providers"));
      return;
    }
    if (key.rightArrow) {
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
      else if (tab === "providers") setProvIdx((i) => Math.min(state.accounts.length - 1, i + 1));
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
      const model = assigned ? state.models.find((m) => m.id === assigned.model) : undefined;
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
          try {
            const res = await api.clearAssignment(row.purpose.id, row.tier);
            if (res.ok) { setState(res.state); setFeedback({ kind: "success", message: "✓ cleared", note: "applies next turn" }); void load(); }
            else setFeedback({ kind: "error", message: `${res.error.code}: ${res.error.message}` });
          } catch (err: any) {
            setFeedback({ kind: "error", message: err.message });
          }
        })();
        return;
      }
      if (isNum && num === 4) {
        void api.resolvePreview(row.purpose.id, (row.tier ?? "standard") as Tier).then((r: any) => {
          if (r?.selectedTarget) {
            setFeedback({
              kind: "idle", message: `${row.key} → ${r.selectedTarget.providerAccount}/${r.selectedTarget.model} (${r.via})`,
            });
          } else {
            setFeedback({ kind: "error", message: "Preview unavailable" });
          }
        }).catch((err: any) => {
          setFeedback({ kind: "error", message: err.message });
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
              ? `✓ ${acct.id}: credential present${r.reachable === false ? " · endpoint unreachable" : ""}`
              : `⚠ ${acct.id}: credential missing or unresolvable`,
          });
        }).catch((e) => setFeedback({ kind: "error", message: String(e) }));
        return;
      }
      if (isNum && num === 3) {
        void api.refreshModels(acct.id).then((r) => {
          if (r.ok && r.state) {
            setState(r.state);
            const discoverySupported = ["openai", "openai-compatible", "google"].includes(acct.upstreamProvider?.toLowerCase());
            setFeedback({
              kind: "success",
              message: r.discovered && r.discovered.length > 0
                ? `✓ discovered ${r.discovered.length} models for ${acct.id}`
                : discoverySupported
                  ? `✓ 0 new models for ${acct.id} — already up to date`
                  : `Model discovery isn't available for ${acct.upstreamProvider} yet — declare models on the account if any are missing.`,
            });
          } else if (r.error) {
            setFeedback({ kind: "error", message: `${r.error.code}: ${r.error.message}` });
          }
        }).catch((e) => setFeedback({ kind: "error", message: String(e) }));
        return;
      }
      if (isNum && num === 4) {
        void api.deleteAccount(acct.id).then((r) => {
          if (r.ok) { setState(r.state); setFeedback({ kind: "success", message: `✓ removed ${acct.id}` }); void load(); }
          else if ("blocked" in r) setOverlay({ kind: "remove-confirm", accountId: acct.id, slots: r.referencingSlots });
          else setFeedback({ kind: "error", message: `${r.error.code}: ${r.error.message}` });
        }).catch((e) => setFeedback({ kind: "error", message: String(e) }));
        return;
      }
      return;
    }

    // now tab
    if (isNum && num === 1) void load();
  });

  return {
    state,
    setState,
    loadError,
    tab,
    setTab,
    overlay,
    setOverlay,
    slotIdx,
    setSlotIdx,
    provIdx,
    setProvIdx,
    fallbacks,
    feedback,
    setFeedback,
    load,
    slotRows,
    slotInfo,
    upstreams,
    teasers,
    assign,
  };
}
