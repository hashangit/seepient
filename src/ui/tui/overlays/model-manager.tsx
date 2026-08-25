/**
 * Seepient TUI — Model & Provider Manager Dock (013, rebuilt in place).
 *
 * Contracts: Implementation-Specs/013-provider-management-tui/contracts/
 * model-manager-dock.md. Three tabs (Jobs · Providers · Now) cycled with Tab.
 * Thin composition root delegating to useManagerState and tab/dialog components.
 */

import React from "react";
import { Box, Text, render } from "ink";
import { ThemeProvider, useTheme } from "../hooks/use-theme.js";
import { ModelPicker } from "../components/model-picker.js";
import { AddAccount } from "../components/add-account.js";
import type {
  ProviderManagerApi,
} from "../../../transport/cli/provider-manager-api.js";
import { isOAuthSupported } from "../../../transport/cli/provider-manager-api.js";
import { useManagerState } from "./model-manager/use-manager-state.js";
import { JobsTab } from "./model-manager/jobs-tab.js";
import { ProvidersTab } from "./model-manager/providers-tab.js";
import { NowTab } from "./model-manager/now-tab.js";
import { SignInFlow, type SignInFlowProps } from "./model-manager/sign-in-flow.js";
import { RemoveConfirm, ThinkingEditor } from "./model-manager/dialogs.js";

export interface ModelManagerProps {
  api: ProviderManagerApi;
  activeAccount?: string;
  activeModel?: string;
  activeThinking?: string;
  sessionNotice?: string;
  prefill?: string;
  initialSignIn?: string;
  initialTab?: "jobs" | "providers" | "now";
  onSessionSwitch?: (acct: string, mdl: string) => void;
  onClose: () => void;
}

export { SignInFlow, type SignInFlowProps };

export function ModelManager(props: ModelManagerProps) {
  const {
    api,
    activeAccount,
    activeModel,
    activeThinking,
    sessionNotice,
    onSessionSwitch,
    onClose,
  } = props;

  const theme = useTheme();
  const {
    state,
    setState,
    loadError,
    tab,
    overlay,
    setOverlay,
    slotIdx,
    provIdx,
    fallbacks,
    feedback,
    setFeedback,
    load,
    slotRows,
    slotInfo,
    upstreams,
    teasers,
    assign,
  } = useManagerState(props);

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
            onSessionSwitch?.(acct, mdl);
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
      <Box flexDirection="column">
        <ThinkingEditor
          title={`Thinking for ${overlay.purpose}${overlay.tier ? `·${overlay.tier}` : ""}`}
          levels={overlay.levels}
          current={overlay.current}
          onPick={(level) => {
            void (async () => {
              try {
                const err = await assign(overlay.purpose, overlay.tier, { ...overlay.target, thinkingLevel: level as any });
                if (!err) setOverlay(null);
              } catch (err: any) {
                setFeedback({ kind: "error", message: err?.message ?? String(err) });
              }
            })();
          }}
          onClose={() => setOverlay(null)}
        />
        {feedback?.message ? (
          <Box marginTop={1}>
            <Text color={feedback.kind === "error" ? theme.red : feedback.kind === "success" ? theme.green : theme.fgDim}>
              {feedback.message}
            </Text>
          </Box>
        ) : null}
      </Box>
    );
  }

  if (overlay?.kind === "add-account") {
    return (
      <AddAccount
        upstreams={upstreams}
        existingIds={state.accounts.map((a) => a.id)}
        prefillUpstream={overlay.prefill}
        canSignIn={(u) => isOAuthSupported(u)}
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
          onDone={(msg, isErr) => { setOverlay(null); setFeedback({ kind: isErr ? "error" : "success", message: msg }); void load(); }}
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
      <JobsTab
        slotRows={slotRows}
        slotIdx={slotIdx}
        slotInfo={slotInfo}
        fallbacks={fallbacks}
        tabBar={tabBar}
        footer={footer}
      />
    );
  }

  if (tab === "providers") {
    return (
      <ProvidersTab
        accounts={state.accounts}
        provIdx={provIdx}
        teasers={teasers}
        tabBar={tabBar}
        footer={footer}
      />
    );
  }

  return (
    <NowTab
      state={state}
      activeAccount={activeAccount}
      activeModel={activeModel}
      activeThinking={activeThinking}
      sessionNotice={sessionNotice}
      tabBar={tabBar}
      footer={footer}
    />
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
