/**
 * 013 T022 — Setup Wizard (contract setup-wizard.md): guided standalone Ink
 * flow reusing the shared AddAccount + ModelPicker. Skip rules derive from
 * live state (research D5 — nothing persisted about the wizard itself).
 * Extras save per-key through a settings adapter (merge-safe by construction,
 * FR-006); the wrapper (setup.ts) owns the non-interactive guard and the
 * documents-workspace creation.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { render } from "ink";
import { Box, Text, useInput } from "ink";
import { ThemeProvider } from "./hooks/use-theme.js";
import { AddAccount } from "./components/add-account.js";
import { ModelPicker } from "./components/model-picker.js";
import type {
  ProviderManagerApi, ManagerState, PurposeId, Tier, AssignmentTarget, UiError, AccountInput,
} from "../../transport/cli/provider-manager-api.js";

export interface WizardExtrasField {
  dotKey: string;
  label: string;
  secret?: boolean;
}

export interface WizardExtrasGroup {
  id: string;
  label: string;
  fields: WizardExtrasField[];
}

/** All extras keys are schema-validated dot-keys (verified vs settings-schema). */
export const EXTRAS_GROUPS: WizardExtrasGroup[] = [
  {
    id: "image", label: "Image service",
    fields: [
      { dotKey: "image.apiKey", label: "API key", secret: true },
      { dotKey: "image.baseUrl", label: "Base URL" },
      { dotKey: "image.model", label: "Model" },
    ],
  },
  {
    id: "email", label: "Email (SMTP)",
    fields: [
      { dotKey: "smtp.host", label: "Host" },
      { dotKey: "smtp.port", label: "Port" },
      { dotKey: "smtp.user", label: "Username" },
      { dotKey: "smtp.pass", label: "Password", secret: true },
      { dotKey: "smtp.from", label: "From address" },
    ],
  },
  {
    id: "search", label: "Web search (Tavily)",
    fields: [{ dotKey: "search.tavilyApiKey", label: "API key", secret: true }],
  },
  {
    id: "bots", label: "Group bots",
    fields: [
      { dotKey: "notifications.feishu.webhook", label: "Feishu webhook", secret: true },
      { dotKey: "notifications.feishu.keyword", label: "Feishu keyword" },
      { dotKey: "notifications.dingtalk.webhook", label: "DingTalk webhook", secret: true },
      { dotKey: "notifications.dingtalk.keyword", label: "DingTalk keyword" },
      { dotKey: "notifications.wecom.webhook", label: "WeCom webhook", secret: true },
      { dotKey: "notifications.wecom.keyword", label: "WeCom keyword" },
    ],
  },
];

export interface SettingsAdapter {
  get(dotKey: string): Promise<string | undefined>;
  set(dotKey: string, value: string): Promise<void>;
}

type Step = "welcome" | "connect" | "main" | "slots" | "extras" | "summary";

interface Summary {
  accounts: string[];
  mainModel?: string;
  slots: string[];
  extrasKeys: string[];
}

export interface SetupWizardProps {
  api: ProviderManagerApi;
  settings: SettingsAdapter;
  onFinish: (s: Summary) => void;
  onExitSetup: () => void;
}

export function SetupWizard({ api, settings, onFinish, onExitSetup }: SetupWizardProps) {
  const [state, setState] = useState<ManagerState | null>(null);
  const [step, setStep] = useState<Step>("welcome");
  const [sub, setSub] = useState<"menu" | "picker" | "add" | "group">("menu");
  const [activeSlot, setActiveSlot] = useState<{ purpose: PurposeId; tier: Tier | null; key: string } | null>(null);
  const [activeGroup, setActiveGroup] = useState<WizardExtrasGroup | null>(null);
  const [fieldIdx, setFieldIdx] = useState(0);
  const [fieldVal, setFieldVal] = useState("");
  const [groupDone, setGroupDone] = useState<Record<string, boolean>>({});
  const [summary, setSummary] = useState<Summary>({ accounts: [], slots: [], extrasKeys: [] });
  const [error, setError] = useState<string | null>(null);
  const [confirmExit, setConfirmExit] = useState(false);

  const load = useCallback(async () => setState(await api.getState()), [api]);
  useEffect(() => { void load().catch((e) => setError(String(e))); }, [load]);

  const mainAssigned = !!(state?.assignments as any)?.text?.standard;
  const emptySlots = useMemo(() => {
    if (!state) return [];
    const out: Array<{ purpose: PurposeId; tier: Tier | null; key: string }> = [];
    for (const p of state.purposes) {
      if (p.id === "text") continue; // handled by the main-model step
      if (p.tiered) {
        for (const t of ["standard", "efficient", "complex"] as const) {
          if (!(state.assignments as any)?.[p.id]?.[t]) out.push({ purpose: p.id, tier: t, key: `${p.id}·${t}` });
        }
      } else if (!(state.assignments as any)?.media?.[p.id.slice("media.".length)]) {
        out.push({ purpose: p.id, tier: null, key: p.id });
      }
    }
    return out;
  }, [state]);

  const healthyAccounts = (state?.accounts ?? []).filter((a) => a.health === "ok" || a.health === "unverified");
  const next = (to: Step): void => { setError(null); setStep(to); };

  function tryExit(): void {
    const dirty = summary.accounts.length > 0 || summary.mainModel || summary.slots.length > 0 || summary.extrasKeys.length > 0;
    if (dirty) setConfirmExit(true);
    else onExitSetup();
  }

  async function doAssign(purpose: PurposeId, tier: Tier | null, t: AssignmentTarget): Promise<UiError | null> {
    const res = await api.setAssignment(purpose, tier, t);
    if (res.ok) {
      setState(res.state);
      if (purpose === "text" && tier === "standard") {
        setSummary((s) => ({ ...s, mainModel: `${t.providerAccount}/${t.model}` }));
        setSub("menu");
        next("slots");
      } else {
        setSummary((s) => ({ ...s, slots: [...new Set([...s.slots, `${purpose}${tier ? `·${tier}` : ""}`])] }));
        setSub("menu");
      }
      return null;
    }
    setError(`${res.error.code}: ${res.error.message}`);
    return res.error;
  }

  // ── Input ─────────────────────────────────────────────────────────────────
  useInput((input, key) => {
    if (confirmExit) {
      if (input === "1") onExitSetup();
      else if (input === "2" || key.escape) setConfirmExit(false);
      return;
    }
    const num = parseInt(input ?? "", 10);
    const isNum = !Number.isNaN(num) && input !== "" && input !== " ";

    if (sub === "add" || sub === "picker") {
      if (key.escape) setSub("menu");
      return; // sub-components own their input
    }

    if (sub === "group" && activeGroup) {
      if (key.escape) { setActiveGroup(null); setSub("menu"); return; }
      if (key.return) {
        void (async () => {
          const f = activeGroup.fields[fieldIdx];
          if (fieldVal.trim()) {
            try { await settings.set(f.dotKey, fieldVal.trim()); setSummary((s) => ({ ...s, extrasKeys: [...new Set([...s.extrasKeys, f.dotKey])] })); }
            catch (e) { setError(String(e)); return; }
          }
          setFieldVal("");
          if (fieldIdx + 1 >= activeGroup.fields.length) {
            setGroupDone((g) => ({ ...g, [activeGroup.id]: true }));
            setActiveGroup(null);
            setSub("menu");
            setFieldIdx(0);
          } else setFieldIdx(fieldIdx + 1);
        })();
        return;
      }
      if (key.backspace || key.delete) { setFieldVal((v) => v.slice(0, -1)); return; }
      if (input && !key.ctrl && !key.meta && input >= " ") setFieldVal((v) => v + input);
      return;
    }

    // sub === menu
    switch (step) {
      case "welcome":
        if (key.return || (isNum && num === 1)) next(healthyAccounts.length > 0 ? "main" : "connect");
        else if (isNum && num === 2) tryExit();
        return;
      case "connect":
        if (isNum && num === 1) setSub("add");
        else if (isNum && num === 2) next("main");
        else if (isNum && num === 3) tryExit();
        return;
      case "main":
        if (mainAssigned && (isNum && num === 1)) next("slots");
        else if (isNum && num === 2 || (!mainAssigned && key.return)) setSub("picker");
        else if (isNum && num === 3) tryExit();
        return;
      case "slots":
        if ((isNum && num === 1) || key.return) {
          if (emptySlots.length > 0) { setActiveSlot(emptySlots[0]); setSub("picker"); }
        } else if (isNum && num === 2) next("extras");
        else if (isNum && num === 3) tryExit();
        return;
      case "extras": {
        const groupN = EXTRAS_GROUPS.findIndex((g) => g.id === EXTRAS_GROUPS[num - 1]?.id);
        if (isNum && num >= 1 && num <= EXTRAS_GROUPS.length && groupN >= 0) {
          setActiveGroup(EXTRAS_GROUPS[num - 1]); setSub("group"); setFieldIdx(0); setFieldVal("");
        } else if ((isNum && num === EXTRAS_GROUPS.length + 1) || key.return) next("summary");
        else if (isNum && num === EXTRAS_GROUPS.length + 2) next("summary");
        return;
      }
      case "summary":
        if (key.return || (isNum && num === 1)) onFinish(summary);
        else if (isNum && num === 2) next("extras");
        return;
    }
  });

  if (confirmExit) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingLeft={1} paddingRight={1}>
        <Text color={"yellow"}>Exit setup? Some changes were already saved.</Text>
        <Text> [1] Exit anyway   [2] Keep going</Text>
      </Box>
    );
  }

  if (sub === "add") {
    const upstreams = state ? [...new Set(state.models.map((m) => m.upstreamProvider))].map((id) => ({
      id, modelCount: state.models.filter((m) => m.upstreamProvider === id).length,
    })) : [];
    return (
      <AddAccount
        upstreams={upstreams}
        existingIds={state?.accounts.map((a) => a.id) ?? []}
        onSaveAccount={async (acctInput: AccountInput) => {
          const res = await api.saveAccount(acctInput);
          if (res.ok) {
            setState(res.state);
            setSummary((s) => ({ ...s, accounts: [...new Set([...s.accounts, acctInput.accountId])] }));
            return null;
          }
          return res.error;
        }}
        onClose={() => setSub("menu")}
      />
    );
  }

  if (sub === "picker" && state) {
    const purpose = step === "main" ? ("text" as PurposeId) : activeSlot?.purpose ?? "text";
    const tier: Tier | null = step === "main" ? "standard" : activeSlot?.tier ?? null;
    return (
      <ModelPicker
        mode="assign"
        title={step === "main" ? "Pick your main model (text·standard)" : `Assign ${activeSlot?.key ?? ""}`}
        purposes={state.purposes}
        assignments={state.assignments}
        models={state.models}
        activePurpose={purpose}
        canSessionSwitch={false}
        onAssign={(t) => doAssign(purpose, tier, t)}
        onSessionSwitch={() => {}}
        onConnectProvider={() => setSub("add")}
        onClose={() => setSub("menu")}
      />
    );
  }

  if (sub === "group" && activeGroup) {
    const f = activeGroup.fields[fieldIdx];
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingLeft={1} paddingRight={1}>
        <Text color="cyan" bold>{activeGroup.label} ({fieldIdx + 1}/{activeGroup.fields.length})</Text>
        <Text color="gray">{f.label} ({f.dotKey}) — leave empty to skip{f.secret ? " (input masked)" : ""}</Text>
        <Text>{`> ${f.secret ? "*".repeat(fieldVal.length) : fieldVal}▏`}</Text>
        <Text color="gray">Enter next · Esc back</Text>
        {error ? <Text color="red">{error}</Text> : null}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="purple" paddingLeft={1} paddingRight={1}>
      <Text bold color="purple">Seepient Setup Wizard</Text>
      {error ? <Text color="red">{error}</Text> : null}

      {step === "welcome" ? (
        <Box flexDirection="column">
          <Text>Connect a provider, pick your main model, and optionally staff more jobs</Text>
          <Text color={"gray"}>and configure integrations. Everything is saved as you go.</Text>
          <Text color={"gray"}> [1] Continue   [2] Exit setup</Text>
        </Box>
      ) : null}

      {step === "connect" ? (
        <Box flexDirection="column">
          {healthyAccounts.length > 0 ? (
            <Text color="green">✓ {healthyAccounts.length} account(s) already connected{state?.accounts.some((a) => a.health === "missing") ? " (one needs attention — test it from /models later)" : ""}</Text>
          ) : (
            <Text>Connect at least one provider to continue.</Text>
          )}
          <Text color={"gray"}> [1] Add provider   [2] Continue{healthyAccounts.length === 0 ? " (disabled — add first)" : ""}   [3] Exit setup</Text>
        </Box>
      ) : null}

      {step === "main" ? (
        <Box flexDirection="column">
          {mainAssigned ? (
            <Text color="green">✓ Main model already set: {(state?.assignments as any).text.standard.providerAccount}/{(state?.assignments as any).text.standard.model}</Text>
          ) : (
            <Text>Pick your main model — the one new conversations use.</Text>
          )}
          <Text color={"gray"}> {mainAssigned ? "[1] Continue   [2] Change model   [3] Exit setup" : "Enter pick model   [3] Exit setup"}</Text>
        </Box>
      ) : null}

      {step === "slots" ? (
        <Box flexDirection="column">
          <Text>{emptySlots.length > 0 ? `${emptySlots.length} job slots are unstaffed — they fall back sensibly.` : "✓ All job slots staffed."}</Text>
          <Text color={"gray"}> [1] Assign next slot{emptySlots.length === 0 ? " (none left)" : ` (${emptySlots[0].key})`}   [2] Skip   [3] Exit setup</Text>
        </Box>
      ) : null}

      {step === "extras" ? (
        <Box flexDirection="column">
          <Text>Optional integrations — each value is saved individually; nothing else is touched.</Text>
          {EXTRAS_GROUPS.map((g, i) => (
            <Text key={g.id} color={groupDone[g.id] ? "green" : undefined}>{` [${i + 1}] ${g.label}${groupDone[g.id] ? " ✓" : ""}`}</Text>
          ))}
          <Text color={"gray"}> [${EXTRAS_GROUPS.length + 1}] Done   [${EXTRAS_GROUPS.length + 2}] Skip</Text>
        </Box>
      ) : null}

      {step === "summary" ? (
        <Box flexDirection="column">
          <Text bold color="green">Setup complete</Text>
          {summary.accounts.length > 0 ? <Text>Accounts connected: {summary.accounts.join(", ")}</Text> : null}
          {summary.mainModel ? <Text>Main model: {summary.mainModel}</Text> : <Text color="yellow">Main model: not set — the default policy will apply</Text>}
          {summary.slots.length > 0 ? <Text>Job slots staffed: {summary.slots.join(", ")}</Text> : null}
          {summary.extrasKeys.length > 0 ? <Text>Integrations saved: {summary.extrasKeys.join(", ")}</Text> : null}
          <Text color={"gray"}>Run `seepient` to start. Manage everything later with /models.</Text>
          <Text color={"gray"}> [1] Finish   [2] Back to integrations</Text>
        </Box>
      ) : null}
    </Box>
  );
}

/** Standalone entry (contract §6): fresh render, unmounted in finally. */
export async function runSetupWizard(options: {
  project?: boolean;
  buildApi?: () => ProviderManagerApi;
  buildSettings?: () => SettingsAdapter;
}): Promise<void> {
  const { getDefaultProviderRuntime } = await import("../../domain/providers/provider-runtime.js");
  const { createProviderManagerApi } = await import("../../transport/cli/provider-manager-api.js");
  const { SettingsManager } = await import("../../domain/settings/settings-manager.js");
  const { loadMergedConfig, loadJsonConfig, getConfigPaths, applyEnvOverrides } = await import("../../transport/cli/config-loader.js");

  const api = options.buildApi ? options.buildApi() : createProviderManagerApi(getDefaultProviderRuntime());

  const paths = getConfigPaths();
  const project = options.project === true;
  const sm = new SettingsManager({
    config: applyEnvOverrides(loadMergedConfig()),
    projectConfigPath: project ? paths.local : paths.local,
    globalConfigPath: paths.global,
    projectConfig: loadJsonConfig(paths.local) as Record<string, any>,
    globalConfig: loadJsonConfig(paths.global) as Record<string, any>,
  });
  const settings: SettingsAdapter = options.buildSettings
    ? options.buildSettings()
    : {
        get: async (k) => {
          const v = sm.get(k).value;
          return v == null ? undefined : String(v);
        },
        set: (k, v) => sm.set(k, v),
      };

  await new Promise<void>((resolve) => {
    let instance: ReturnType<typeof render>;
    instance = render(
      <ThemeProvider>
        <SetupWizard
          api={api}
          settings={settings}
          onFinish={() => { instance.unmount(); resolve(); }}
          onExitSetup={() => { instance.unmount(); resolve(); }}
        />
      </ThemeProvider>,
      { exitOnCtrlC: true },
    );
  });
}
