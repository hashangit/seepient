import { useEffect, useRef, useState, useMemo } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from './hooks/use-theme.js';
import { useFeed } from './hooks/use-feed.js';
import { useAgent } from './hooks/use-agent.js';
import { useKeybindings } from './hooks/use-keybindings.js';
import { useFileWatcher } from './hooks/use-file-watcher.js';
import { useCursor } from './hooks/use-cursor.js';
import { createWidgetHost } from './widget-host.js';
import { stabilizeStreamingText } from './stream-commit-gate.js';
import { MessageArea } from './components/message-area.js';
import { PromptArea } from './components/prompt-area.js';
import { PermissionPrompt, LegacyPermissionPrompt } from './components/permission-prompt.js';
import { AssistantMessage } from './components/assistant-message.js';
import { ToolCallBlock } from './components/tool-call-block.js';
import { GoalStatus } from './components/goal-status.js';

import { Footer } from './components/footer.js';
import Spinner from 'ink-spinner';
import { CommandPalette } from './components/command-palette.js';
import { HelpDialog } from './overlays/help-dialog.js';
import { ModelManager } from './overlays/model-manager.js';
import { SetupWizard } from './setup-wizard.js';
import { createProviderManagerApi } from '../../transport/cli/provider-manager-api.js';
import { SessionSelector, type SessionListItem } from './overlays/session-selector.js';
import { SettingsEditor, type SettingItem } from './overlays/settings-overlay.js';
import { messagesToFeedEntries } from './feed-serializer.js';
import type { Suggestion } from './components/autocomplete.js';
import type { Agent } from '../../transport/cli/agent.js';
import type { PermissionLevel } from '../../foundations/types.js';
import { getModelMeta } from '../../foundations/models-catalog.js';
import { HORIZONTAL_PADDING } from './layout.js';

/** Outcome of dispatching a slash command in the TUI (built in startTui). */
export interface TuiCommandOutcome {
  status: 'handled' | 'fallthrough';
  /** Command owns stdin/stdout — the TUI can't run it (deferred to a later phase). */
  deferred?: boolean;
  /** ANSI-styled text; the TUI strips ANSI before rendering. */
  output?: string;
  /** Structured payload rendered by a dedicated TUI component (preferred over `output`). */
  render?: import('../../transport/cli/commands/registry.js').CommandRender;
  /** Session should terminate. */
  exit?: boolean;
}

type Overlay = 'palette' | 'help' | 'model' | 'settings' | 'sessions' | 'setup' | null;

/** Strip ANSI escapes — handler output is chalk-styled for the readline path. */
function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
}

interface TuiAppProps {
  agent: Agent;
  permissionLevel?: PermissionLevel;
  initialQuery?: string;
  onExit: () => void;
  dispatchCommand: (input: string) => Promise<TuiCommandOutcome>;
  commands: Suggestion[];
  skills: Suggestion[];
  /** Reset Ink's accumulated Static output + clear screen before a `<Static>`
   *  remount (resize / expand / session-resume) so history repaints cleanly. */
  resetView: () => void;
  /** Footer status info from the session. */
  providerType: string;
  gatewayOn: boolean;
  skillCount: number;
  mcpCount: number;
  getSettingsList: () => SettingItem[];
  onSetSetting: (dotKey: string, value: string) => Promise<void>;
  listSessions: () => Promise<SessionListItem[]>;
  onSwitchSession: (sessionId: string) => Promise<{ preview: string; userMessageCount: number; toolCallCount: number } | null>;
  onDeleteSession: (sessionId: string) => Promise<void>;
  onExportSession: (sessionId: string) => Promise<string | null>;
  onTranscriptSession: (sessionId: string) => Promise<string | null>;
  onRenameSession: (sessionId: string, title: string) => Promise<boolean>;
  getSessionId: () => string;
}

/**
 * TuiApp — Ink `<Static>` + native terminal scroll (like Command Code: the wheel
 * scrolls the terminal's own scrollback, so no mouse capture / no gibberish).
 * `<MessageArea>` grows the scrollback; the live region swaps between modal
 * overlays, the inline permission prompt, a "working" indicator, and the input
 * prompt. A status footer is always at the bottom of the written content.
 * `ink-reset.ts` (`resetView`) keeps resize/expand repaints artifact-free.
 */
export function TuiApp({
  agent, permissionLevel, initialQuery, onExit, dispatchCommand, commands, skills, resetView,
  providerType, gatewayOn, skillCount, mcpCount, getSettingsList, onSetSetting,
  listSessions, onSwitchSession, onDeleteSession, onExportSession, onTranscriptSession, onRenameSession, getSessionId,
}: TuiAppProps) {
  const theme = useTheme();
  const feed = useFeed();
  const widgetHost = useMemo(() => createWidgetHost(feed), []);
  // Dispose all widget blocks on unmount (prevents orphan timers/subscriptions).
  useEffect(() => () => widgetHost.disposeAll(), [widgetHost]);

  const agentApi = useAgent({
    agent,
    feed,
    permissionLevel,
    widgetHost,
  });
  const { isRunning, pendingPermission, streamingText, streamingTool, usage, contextTokens, latestTodos, submit, resolvePermission, abort, resetTodos, restoreTodos } = agentApi;

  // Wire the submit callback into the widget host (submit is created inside useAgent).
  useEffect(() => {
    widgetHost.setSubmit((synthetic: string) => { void submit(synthetic); });
  }, [widgetHost, submit]);
  const [input, setInput] = useState('');
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [settingsList, setSettingsList] = useState<SettingItem[]>([]);
  const [sessionsList, setSessionsList] = useState<SessionListItem[]>([]);

  // Widget focus — only active when agent is idle. When set, widgets render
  // interactively (↑/↓ cycles actions, Enter fires) and prompt input is
  // disabled so its Enter handler can't compete with the widget's.
  const [focusedWidgetId, setFocusedWidgetId] = useState<string | null>(null);
  // Reset focus when agent starts running (widget is being generated).
  useEffect(() => { if (isRunning) setFocusedWidgetId(null); }, [isRunning]);

  // Ctrl+T cycles focus between prompt and interactive widgets at idle.
  // null → first widget → next widget → … → last → null (back to prompt).
  const onCycleWidgetFocus = (): void => {
    if (isRunning) return;
    const liveWidgets = feed.entries.filter((e) => e.kind === 'block' && !e.finalized);
    if (liveWidgets.length === 0) {
      setFocusedWidgetId(null);
      return;
    }
    const ids = liveWidgets.map((e) => e.id);
    const idx = focusedWidgetId ? ids.indexOf(focusedWidgetId) : -1;
    // null (-1) → first widget; otherwise advance; wrap past last → null (prompt).
    const next = idx + 1 >= ids.length ? null : ids[idx + 1];
    setFocusedWidgetId(next);
  };

  // File-watcher: notifies when project files change externally while idle.
  const { changedFile, clear: clearFileChange } = useFileWatcher(!isRunning);

  // T0-3: hide cursor during streaming, restore on idle / pending permission.
  useCursor(isRunning, !!pendingPermission);

  // Input history lives here (not in PromptArea) so it survives PromptArea
  // unmounting during a run — otherwise every turn wiped the history.
  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef(-1);
  // The in-progress prompt, saved on first ↑ so ↓ back to the present restores it.
  const draftRef = useRef('');

  // Queue: chat messages typed during a run are buffered and drained one per
  // run completion (like other AI coding TUIs). isRunningRef mirrors state for
  // synchronous reads inside the handleUserInput event handler.
  const isRunningRef = useRef(false);
  isRunningRef.current = isRunning;
  const queueRef = useRef<string[]>([]);
  const [queuedCount, setQueuedCount] = useState(0);

  const [staticKey, setStaticKey] = useState(0);
  const [expanded, setExpanded] = useState(false);

  // Resize → reset Ink's Static buffer + remount <Static> for a clean repaint.
  useEffect(() => {
    const onResize = (): void => {
      resetView();
      setStaticKey((k) => k + 1);
    };
    process.stdout.on('resize', onResize);
    return () => {
      process.stdout.off('resize', onResize);
    };
  }, [resetView]);

  // 013: the model manager dock talks to the ProviderManagerApi controller —
  // one semantic core shared with the wizard, CLI handlers, and SDK (R15).
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);
  const managerApi = useMemo(
    () =>
      createProviderManagerApi(agent.getProviderRuntime(), {
        switchProvider: (account, model) => {
          agent.switchProvider(account, model);
          setSessionNotice(`${account}/${model} — session, not saved`);
        },
      }),
    [agent],
  );
  const [modelTab, setModelTab] = useState<'jobs' | 'providers' | 'now'>('jobs');
  const [modelPrefill, setModelPrefill] = useState<string | undefined>(undefined);
  const [modelSignIn, setModelSignIn] = useState<string | undefined>(undefined);

  const didInit = useRef(false);
  useEffect(() => {
    if (didInit.current) return;
    didInit.current = true;
    feed.appendEntry({ kind: 'logo' });
    if (initialQuery && initialQuery.trim()) {
      void submit(initialQuery);
    }
  }, [initialQuery, submit, feed]);

  // Drain the queue when a run finishes — submit the next queued message.
  // Each submission's completion (isRunning→false) re-fires this effect,
  // draining one message at a time until the queue is empty.
  useEffect(() => {
    if (!isRunning && queueRef.current.length > 0) {
      const next = queueRef.current.shift()!;
      setQueuedCount(queueRef.current.length);
      void submit(next);
    }
  }, [isRunning, submit]);

  // Full clear — start a new session (the agent rotates the session id) + a
  // fresh TUI: empty the feed, reset todos, re-seed the logo, clear the screen
  // and remount <Static>. Shared by the `/clear` command and the Ctrl+L binding.
  const clearAll = (): void => {
    agent.clearConversation();
    feed.clear();
    resetTodos();
    feed.appendEntry({ kind: 'logo' });
    resetView();
    setStaticKey((k) => k + 1);
  };

  // Run a /command via the shared registry; surface its output in the feed.
  const runSlash = async (raw: string): Promise<void> => {
    const name = raw.split(/\s+/)[0];
    const result = await dispatchCommand(raw);
    if (result.deferred) {
      feed.appendEntry({ kind: 'assistant', content: `${name} is interactive — run it in the readline REPL (seepient), or wait for the TUI overlay.` });
    } else if (result.exit) {
      onExit();
    } else if (result.render) {
      // Structured payload → dedicated component (e.g. SkillsList for /skills).
      feed.appendEntry({ kind: 'block', blockKind: 'custom', props: result.render, finalized: true });
    } else if (result.output) {
      feed.appendEntry({ kind: 'assistant', content: stripAnsi(result.output) });
    } else if (result.status === 'fallthrough') {
      feed.appendEntry({ kind: 'assistant', content: `${name} skill launch from the TUI arrives in US2 — ask in chat, or run it in the readline REPL.` });
    }
  };

  const handleUserInput = async (value: string): Promise<void> => {
    const trimmed = value.trim();
    if (trimmed) {
      historyRef.current.push(trimmed);
      historyIndexRef.current = -1;
    }
    setInput('');
    clearFileChange();

    // /steer <message> — interrupt the current run and send a new message.
    if (trimmed === '/steer' || trimmed.startsWith('/steer ')) {
      const steerMsg = trimmed.slice('/steer'.length).trim();
      if (!steerMsg) {
        feed.appendEntry({ kind: 'info', content: 'Usage: /steer <message> — interrupts the current run and sends a new message.' });
        return;
      }
      if (isRunningRef.current) {
        abort();
        queueRef.current.unshift(steerMsg);
        setQueuedCount(queueRef.current.length);
        feed.appendEntry({ kind: 'info', content: 'Steering — current run aborted, sending next.' });
      } else {
        void submit(steerMsg);
      }
      return;
    }

    // During an active run, queue chat messages and block all other commands.
    if (isRunningRef.current) {
      if (trimmed.startsWith('/')) {
        feed.appendEntry({ kind: 'info', content: 'Command unavailable during a run — use /steer <message> to interrupt, or wait for the run to finish.' });
      } else if (trimmed) {
        queueRef.current.push(trimmed);
        setQueuedCount(queueRef.current.length);
        feed.appendEntry({ kind: 'info', content: `Queued (${queueRef.current.length}) — will submit when the run finishes. /steer to send now.` });
      }
      return;
    }

    if (trimmed === '/?') {
      setOverlay('help');
      return;
    }
    if (trimmed.startsWith('/model ') || trimmed === '/model' || trimmed === '/models') {
      const search = trimmed.startsWith('/model ') ? trimmed.slice('/model '.length).trim() : undefined;
      setModelPrefill(search);
      setModelTab('jobs');
      setOverlay('model');
      return;
    }
    if (trimmed === '/providers') {
      setModelPrefill(undefined);
      setModelTab('providers');
      setOverlay('model');
      return;
    }
    if (trimmed.startsWith('/login ') || trimmed === '/login') {
      const explicit = trimmed.startsWith('/login ') ? trimmed.slice('/login '.length).trim() : undefined;
      const flows = await managerApi.getAvailableOAuthFlows?.().catch(() => []) ?? [];
      const provider = explicit || flows[0];
      setModelPrefill(undefined);
      setModelSignIn(provider);
      setModelTab('providers');
      setOverlay('model');
      return;
    }
    if (trimmed.startsWith('/logout ') || trimmed === '/logout') {
      const account = trimmed.startsWith('/logout ') ? trimmed.slice('/logout '.length).trim() : undefined;
      if (!account) {
        feed.appendEntry({ kind: 'info', content: 'Usage: /logout <account-id>  (e.g. /logout anthropic)' });
        return;
      }
      const res = await managerApi.logoutAccount(account);
      if (res.ok) {
        feed.appendEntry({ kind: 'info', content: `✓ Logged out account "${account}". Associated credentials removed.` });
      } else {
        feed.appendEntry({ kind: 'error', message: `Logout failed: ${res.error.message}` });
      }
      return;
    }
    if (trimmed === '/setup') {
      setOverlay('setup');
      return;
    }
    if (trimmed === '/sessions' || trimmed === '/session') {
      setSessionsList(await listSessions());
      setOverlay('sessions');
      return;
    }
    // `/clear` starts a fresh session + TUI (logo, empty feed) — handled here,
    // not via the registry (which only clears the agent, not the visible feed).
    if (trimmed === '/clear') {
      clearAll();
      return;
    }
    {
      const parts = trimmed.split(/\s+/);
      const cmd = parts[0]?.toLowerCase();
      const sub = parts[1]?.toLowerCase();
      if (['/settings', '/setting', '/config'].includes(cmd)) {
        if (sub === undefined) {
          setSettingsList(getSettingsList());
          setOverlay('settings');
          return;
        }
        if (sub === 'set' && parts.length <= 3) {
          feed.appendEntry({ kind: 'info', content: 'Provide a value: /settings set <key> <value>  (e.g. /settings set gateway.enabled true)' });
          return;
        }
      }
    }
    if (trimmed.startsWith('/')) {
      await runSlash(trimmed);
    } else {
      void submit(value);
    }
  };

  const onHistoryUp = (): void => {
    const h = historyRef.current;
    if (h.length === 0) return;
    if (historyIndexRef.current === -1) draftRef.current = input; // save in-progress prompt
    const next = historyIndexRef.current === -1 ? h.length - 1 : Math.max(0, historyIndexRef.current - 1);
    historyIndexRef.current = next;
    setInput(h[next]);
  };
  const onHistoryDown = (): void => {
    const h = historyRef.current;
    if (h.length === 0 || historyIndexRef.current === -1) return;
    const next = historyIndexRef.current + 1;
    if (next >= h.length) {
      historyIndexRef.current = -1;
      setInput(draftRef.current); // restore in-progress prompt
    } else {
      historyIndexRef.current = next;
      setInput(h[next]);
    }
  };

  // Palette includes synthetic entries that open overlays.
  const paletteCommands: Suggestion[] = [
    ...commands.map((c) => {
      if (c.name === 'models' || c.name === 'model') {
        return { ...c, description: `Switch model (currently ${providerType}/${agent.getModel()})` };
      }
      return c;
    }),
    { name: 'shortcuts', description: 'Keyboard reference' },
    { name: 'model', description: `Switch model (currently ${providerType}/${agent.getModel()})` },
    { name: 'providers', description: 'Manage provider accounts' },
    { name: 'login', description: 'Sign in with provider (OAuth / subscription)' },
    { name: 'logout', description: 'Log out a provider account' },
    { name: 'setup', description: 'Run setup wizard' },
    { name: 'settings', description: 'View settings' },
    { name: 'sessions', description: 'Resume / delete a session' },
  ];
  const onPaletteRun = (name: string, arg?: string): void => {
    setOverlay(null);
    if (name === 'shortcuts') {
      setOverlay('help');
    } else if (name === 'model') {
      setModelPrefill(undefined);
      setModelSignIn(undefined);
      setModelTab('jobs');
      setOverlay('model');
    } else if (name === 'providers') {
      setModelPrefill(undefined);
      setModelSignIn(undefined);
      setModelTab('providers');
      setOverlay('model');
    } else if (name === 'login') {
      void (async () => {
        const flows = await managerApi.getAvailableOAuthFlows?.().catch(() => []) ?? [];
        const provider = arg?.trim() || flows[0];
        setModelPrefill(undefined);
        setModelSignIn(provider);
        setModelTab('providers');
        setOverlay('model');
      })();
    } else if (name === 'logout') {
      setModelPrefill(undefined);
      setModelSignIn(undefined);
      setModelTab('providers');
      setOverlay('model');
    } else if (name === 'setup') {
      setOverlay('setup');
    } else if (name === 'settings') {
      setSettingsList(getSettingsList());
      setOverlay('settings');
    } else if (name === 'sessions') {
      void (async () => {
        setSessionsList(await listSessions());
        setOverlay('sessions');
      })();
    } else {
      void runSlash('/' + name);
    }
  };

  const handleSetSetting = async (dotKey: string, value: string): Promise<void> => {
    await onSetSetting(dotKey, value);
    setSettingsList(getSettingsList());
  };

  // Resume a session: load messages into the agent, rebuild the visual feed,
  // and remount <Static> so history repaints without phantom duplicates.
  const handleSelectSession = async (sessionId: string): Promise<void> => {
    const summary = await onSwitchSession(sessionId);
    setOverlay(null);
    if (!summary) {
      feed.appendEntry({ kind: 'info', content: `Session ${sessionId.slice(0, 8)} could not be loaded.` });
      return;
    }
    feed.clear();
    resetTodos();
    const { entries, latestTodos: sessionTodos } = messagesToFeedEntries(agent.getMessages());
    for (const entry of entries) feed.appendEntry(entry);
    restoreTodos(sessionTodos);
    resetView();
    setStaticKey((k) => k + 1);
    feed.appendEntry({ kind: 'info', content: `Resumed session: ${summary.preview} (${summary.userMessageCount} turns, ${summary.toolCallCount} tool calls)` });
  };

  const handleDeleteSession = async (sessionId: string): Promise<void> => {
    await onDeleteSession(sessionId);
    setSessionsList(await listSessions());
  };

  const handleExportSession = async (sessionId: string): Promise<void> => {
    const outPath = await onExportSession(sessionId);
    feed.appendEntry({ kind: 'info', content: outPath ? `Exported session to ${outPath}` : `Session ${sessionId.slice(0, 8)} could not be exported.` });
  };

  const handleTranscriptSession = async (sessionId: string): Promise<void> => {
    const outPath = await onTranscriptSession(sessionId);
    feed.appendEntry({ kind: 'info', content: outPath ? `Transcript written to ${outPath}` : `Session ${sessionId.slice(0, 8)} could not be exported.` });
  };

  const handleRenameSession = async (sessionId: string, title: string): Promise<boolean> => {
    const ok = await onRenameSession(sessionId, title);
    if (ok) setSessionsList(await listSessions());
    return ok;
  };

  useKeybindings(
    {
      onAbort: abort,
      onExit,
      onExpandToggle: () => { resetView(); setExpanded((e) => !e); setStaticKey((k) => k + 1); },
      onPalette: () => setOverlay('palette'),
      onClear: clearAll,
      onCycleFocus: onCycleWidgetFocus,
      onEscapeWidget: () => { if (focusedWidgetId) setFocusedWidgetId(null); },
    },
    { enabled: overlay === null, isRunning, promptPending: !!pendingPermission },
  );

  // T2: stabilize streaming text for live display. While markdown is reflowing
  // (open fences, incomplete tables, trailing diff removals), hold the unstable
  // portion and show only the last-stable text. The full text is always committed
  // to feed history — this gate is display-only.
  const displayText = streamingText ? stabilizeStreamingText(streamingText).stable : '';

  const showSpinner = isRunning && !streamingText && !pendingPermission;
  // The bordered input is always visible (003 US1). While a tool needs approval
  // the inline prompt replaces it; otherwise the spinner (with queued count)
  // renders ABOVE the input — the input stays active so queued/steered messages
  // can be typed during a run.
  // Spec 011: the native path passes the full typed request to the prompt
  // (keyed by requestId so a new request resets selection state); the legacy
  // flag-off path keeps the raw tool name/arguments view.
  const inputAreaSlot = pendingPermission ? (
    pendingPermission.kind === 'native' ? (
      <PermissionPrompt key={pendingPermission.request.requestId} request={pendingPermission.request} onResolve={resolvePermission} />
    ) : (
      <LegacyPermissionPrompt
        toolName={pendingPermission.view.toolName}
        args={pendingPermission.view.args}
        approvalContext={pendingPermission.view.approvalContext}
        onResolve={resolvePermission}
      />
    )
  ) : (
    <Box flexDirection="column">
      {showSpinner ? (
        <Box>
          <Text color={theme.yellow}><Spinner type="dots" /> Seepient is working </Text>
          <Text color={theme.fgDim}>(Esc to abort){queuedCount > 0 ? ` · ${queuedCount} queued` : ''}</Text>
        </Box>
      ) : null}
      <PromptArea
        value={input}
        onChange={setInput}
        onSubmit={(v) => { void handleUserInput(v); }}
        disabled={focusedWidgetId !== null}
        onHistoryUp={onHistoryUp}
        onHistoryDown={onHistoryDown}
        onCycleFocus={onCycleWidgetFocus}
        commands={commands}
        skills={skills}
      />
    </Box>
  );

  return (
    <Box flexDirection="column" paddingLeft={HORIZONTAL_PADDING} paddingRight={HORIZONTAL_PADDING}>
      <MessageArea
        entries={feed.entries}
        staticKey={staticKey}
        expanded={expanded}
        focusedWidgetId={focusedWidgetId}
        onWidgetAction={(spec, actionId, state) => {
          widgetHost.dispatchAction(spec.id, actionId, state);
        }}
        contextTokens={contextTokens}
      />
      {/* Persistent todo panel — stays visible; updates on each manage_todos call. */}
      {latestTodos ? <GoalStatus todos={latestTodos} /> : null}
      {streamingText ? (
        <AssistantMessage entry={{ id: '__streaming', kind: 'assistant', content: displayText }} />
      ) : null}
      {streamingTool ? (
        <ToolCallBlock
          entry={{ id: '__running-tool', kind: 'tool', name: streamingTool.name, args: streamingTool.args, status: 'running', output: streamingTool.output }}
          expanded={true}
        />
      ) : null}
      <Box flexDirection="column">
        {overlay === 'palette' ? (
          <CommandPalette commands={paletteCommands} skills={skills} onRun={onPaletteRun} onClose={() => setOverlay(null)} />
        ) : overlay === 'help' ? (
          <HelpDialog onClose={() => setOverlay(null)} />
        ) : overlay === 'model' ? (
          <ModelManager
            api={managerApi}
            activeAccount={providerType}
            activeModel={agent.getModel()}
            sessionNotice={sessionNotice ?? undefined}
            prefill={modelPrefill}
            initialSignIn={modelSignIn}
            initialTab={modelTab}
            onClose={() => {
              setModelPrefill(undefined);
              setModelSignIn(undefined);
              setOverlay(null);
            }}
          />
        ) : overlay === 'setup' ? (
          <SetupWizard
            api={managerApi}
            settings={{
              get: async (k) => {
                const item = settingsList.find((s) => s.dotKey === k);
                return item?.value;
              },
              set: async (k, v) => {
                await handleSetSetting(k, v);
              },
            }}
            onFinish={() => setOverlay(null)}
            onExitSetup={() => setOverlay(null)}
          />
        ) : overlay === 'settings' ? (
          <SettingsEditor settings={settingsList} onSet={handleSetSetting} onClose={() => setOverlay(null)} />
        ) : overlay === 'sessions' ? (
          <SessionSelector
            sessions={sessionsList}
            currentSessionId={getSessionId()}
            onSelect={(id) => { void handleSelectSession(id); }}
            onDelete={(id) => { void handleDeleteSession(id); }}
            onExport={(id) => { void handleExportSession(id); }}
            onTranscript={(id) => { void handleTranscriptSession(id); }}
            onRename={(id, title) => handleRenameSession(id, title)}
            onClose={() => setOverlay(null)}
          />
        ) : (
          inputAreaSlot
        )}
      </Box>
      {changedFile ? (
        <Text color={theme.yellow}>~ {changedFile} changed externally</Text>
      ) : null}
      <Footer
        providerType={providerType}
        model={agent.getModel()}
        usage={usage}
        permissionLevel={permissionLevel}
        skillCount={skillCount}
        gatewayOn={gatewayOn}
        mcpCount={mcpCount}
        contextTokens={contextTokens}
        contextWindow={getModelMeta(agent.getModel())?.contextWindow}
      />
    </Box>
  );
}
