/**
 * use-agent — agent run state for the TUI.
 *
 * Drives `Agent.chat(input, signal, approveTool, onStep)` ,
 * which (in TUI mode) opts into token streaming — the loop emits `text_delta`
 * steps as tokens arrive. Those accumulate into `streamingText` (rendered live
 * in the message area, since Ink `<Static>` freezes completed entries); on a
 * tool call or turn end the accumulated text is committed to the feed history.
 * ESC/Ctrl+C calls `agent.abort()`.
 *
 * `approveTool` runs inside the detached `runAgentLoop` promise, so it must
 * pause and wait for the user to press y/n in `<PermissionPrompt>`. This hook
 * owns that bridge: it stores the pending resolver in a ref (stable across
 * renders) and the pending prompt's view in state (so the component re-renders).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Agent, type ChatResult } from '../../../transport/cli/agent.js';
import { InlineApprovalBroker } from '../../../transport/approval-brokers.js';
import type { InlineApprovalPresenter } from '../../../transport/approval-brokers.js';
import type {
  PermissionRequest,
  TuiApprovalSelection,
} from '../../../foundations/contracts/permission-policy.js';
import type { ApproveToolFn, ApprovalContext, ApprovalDecision, StepResult, CumulativeUsage } from '../../../foundations/types.js';
import type { Todo } from '../components/goal-status.js';
import type { FeedApi } from './use-feed.js';
import type { WidgetHost } from '../widget-host.js';
import type { WidgetSpec } from '../widgets/types.js';
import { useStreamFlush } from '../stream-flush.js';

export interface PendingPermissionView {
  toolName: string;
  args: Record<string, unknown>;
  /** LLM-authored gate context (built by the loop from the tool's `approval` arg). */
  approvalContext?: ApprovalContext;
}

/**
 * Spec 011: the native path holds the full typed `PermissionRequest`; the
 * legacy (flag-off) path keeps the raw tool name/arguments view.
 */
export type PendingPermission =
  | { kind: 'native'; request: PermissionRequest }
  | { kind: 'legacy'; view: PendingPermissionView };

export interface StreamingToolView {
  name: string;
  args: Record<string, unknown>;
  output: string;
}

export interface AgentApi {
  isRunning: boolean;
  pendingPermission: PendingPermission | null;
  /** Live, accumulating assistant text while streaming (empty when idle). */
  streamingText: string;
  /** Live, accumulating tool output while a tool runs (null when idle). */
  streamingTool: StreamingToolView | null;
  /** Cumulative token/cost usage across the session (for the footer). */
  usage: CumulativeUsage;
  /** Last turn's input size in tokens — the current context-window usage. */
  contextTokens: number;
  /** Persistent todo list (updated by manage_todos tool; null when none). */
  latestTodos: Todo[] | null;
  submit: (input: string, providerFactory?: import('../../../domain/agent-loop.js').ProviderFactory) => Promise<void>;
  /** Native selections or legacy decisions both flow through this resolver. */
  resolvePermission: (selection: TuiApprovalSelection | ApprovalDecision) => void;
  abort: () => void;
  resetTodos: () => void;
  /** Restore the persistent todo panel (e.g. from a resumed session). */
  restoreTodos: (todos: Todo[] | null) => void;
}

export interface UseAgentArgs {
  agent: Agent;
  feed: FeedApi;
  consentMode?: import('../../../foundations/settings-schema.js').ConsentMode;
  widgetHost?: WidgetHost;
}

export function useAgent({ agent, feed, consentMode, widgetHost }: UseAgentArgs): AgentApi {
  const [isRunning, setIsRunning] = useState(false);
  const [pendingPermission, setPendingPermission] = useState<PendingPermission | null>(null);
  const [streamingText, setStreamingText] = useState('');
  const [streamingTool, setStreamingTool] = useState<StreamingToolView | null>(null);
  const [usage, setUsage] = useState<CumulativeUsage>({
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalCost: 0,
    requestCount: 0,
  });
  const [contextTokens, setContextTokens] = useState(0);
  const [latestTodos, setLatestTodos] = useState<Todo[] | null>(null);

  // Refs hold the latest values so the stable callbacks never close over
  // stale state (CLAUDE.md §6: long-lived callbacks read through refs).
  const feedRef = useRef(feed);
  feedRef.current = feed;
  const resolverRef = useRef<((value: TuiApprovalSelection | ApprovalDecision) => void) | null>(null);

  // Spec 011: the native typed approval broker. Created once; its presenter
  // stores the full PermissionRequest in state and waits for the user's
  // transient selection. The broker enriches the selection into the shared
  // PermissionDecision (actor + timestamp) before the lifecycle validates it.
  const nativeBrokerRef = useRef<InlineApprovalBroker | null>(null);
  // The pending native presenter promise, if any. Settled immediately on
  // request replacement or TUI unmount (FR-020: the prompt must never hang
  // until the broker deadline for a prompt that is no longer visible).
  const pendingNativeRef = useRef<{ settle: (s: TuiApprovalSelection) => void } | null>(null);
  const getNativeBroker = useCallback((): InlineApprovalBroker => {
    let broker = nativeBrokerRef.current;
    if (!broker) {
      const presenter: InlineApprovalPresenter = {
        prompt: (request: PermissionRequest, opts) => {
          setPendingPermission({ kind: 'native', request });
          return new Promise<TuiApprovalSelection>((resolve) => {
            const settle = (value: TuiApprovalSelection): void => {
              // Idempotent: only the CURRENT prompt may settle; a replaced
              // or already-settled prompt ignores late calls.
              if (pendingNativeRef.current !== current) return;
              if (resolverRef.current === onSelection) resolverRef.current = null;
              opts.signal?.removeEventListener('abort', onAbort);
              pendingNativeRef.current = null;
              resolve(value);
            };
            // User path: an Enter/Esc/q selection (or a legacy-style denial)
            // settles this prompt.
            const onSelection = (value: TuiApprovalSelection | ApprovalDecision): void => {
              // Anything that is not an approved choice-ID selection denies
              // safely.
              if (typeof value !== 'boolean' && 'choiceId' in value) {
                settle(value);
              } else {
                settle({ approved: false, reason: 'user-denied' });
              }
            };
            // System path: broker deadline, parent abort, request replacement,
            // or TUI unmount must settle the prompt immediately (FR-020).
            const onAbort = (): void => {
              setPendingPermission(null);
              settle({ approved: false, reason: 'approval-unavailable' });
            };
            // A NEW request replacing a still-open prompt settles the old one
            // immediately: one action produces at most one prompt. `settle`
            // nulls the ref via its own guard path.
            const previous = pendingNativeRef.current;
            if (previous) {
              previous.settle({ approved: false, reason: 'approval-unavailable' });
            }
            const current = { settle };
            pendingNativeRef.current = current;
            // The app's `resolvePermission` bridge and the abort/error paths
            // route through `resolverRef`; register the user path there too
            // (legacy approveTool only sets it when the pipeline is off).
            resolverRef.current = onSelection;
            opts.signal?.addEventListener('abort', onAbort, { once: true });
          });
        },
      };
      broker = new InlineApprovalBroker(presenter);
      nativeBrokerRef.current = broker;
    }
    return broker;
  }, []);

  // The seam must not outlive the TUI: clear it on unmount so a pending
  // prompt can never resolve through a dead surface, and settle a still-open
  // prompt immediately (FR-020).
  useEffect(() => {
    return () => {
      agent.setPipelineApprovalBroker(undefined);
      const pending = pendingNativeRef.current;
      if (pending) {
        // `settle` nulls the ref itself via its guard path; a pre-null
        // would make the guard bail and leave the prompt unresolved.
        pending.settle({ approved: false, reason: 'approval-unavailable' });
      }
    };
  }, [agent]);
  const streamingTextRef = useRef('');
  const streamingToolRef = useRef<StreamingToolView | null>(null);

  // T0-1: throttle streaming renders to ~30fps
  const textFlush = useStreamFlush(() => setStreamingText(streamingTextRef.current));
  const toolFlush = useStreamFlush(() => setStreamingTool(streamingToolRef.current ? { ...streamingToolRef.current } : null));

  /** Commit accumulated streaming text to the feed history as an assistant entry. */
  const commitStreaming = useCallback((): void => {
    if (streamingTextRef.current) {
      feedRef.current.appendEntry({ kind: 'assistant', content: streamingTextRef.current });
      streamingTextRef.current = '';
      setStreamingText('');
    }
  }, []);

  const submit = useCallback(async (
    input: string,
    providerFactory?: import('../../../domain/agent-loop.js').ProviderFactory,
  ): Promise<void> => {
    const trimmed = input.trim();
    if (!trimmed) return;

    // If the user sent a new message (not a widget action), finalize all live
    // widgets — the user is moving on from the widget.
    // Widget actions (synthetic: [widget:id] action "...") keep widgets live
    // so the user can interact with them across multiple turns.
    if (!trimmed.startsWith('[widget:')) {
      widgetHost?.finalizeAll();
    }

    setIsRunning(true);
    streamingTextRef.current = '';
    textFlush.cancel();
    setStreamingText('');
    streamingToolRef.current = null;
    toolFlush.cancel();
    setStreamingTool(null);
    feedRef.current.appendEntry({ kind: 'user', content: trimmed });

    // Resolve @path file references at the caller, not inside Agent.chat (T022).
    let resolvedInput = trimmed;
    if (trimmed.includes('@')) {
      try {
        const { resolveReferences } = await import('../../../capabilities/skills/resolver.js');
        resolvedInput = await resolveReferences(trimmed);
      } catch { /* resolver not available — use raw input */ }
    }

    const signal = agent.createAbortSignal();

    const approveTool: ApproveToolFn = async (call) => {
      // Legacy (flag-off) surface: raw tool name/arguments, unchanged.
      setPendingPermission({
        kind: 'legacy',
        view: { toolName: call.name, args: call.args, approvalContext: call.approvalContext },
      });

      const decision = await new Promise<ApprovalDecision>((resolve) => {
        resolverRef.current = resolve;
      });

      resolverRef.current = null;
      setPendingPermission(null);
      return decision;
    };

    // Spec 011: when the permission pipeline is active, install the native
    // typed broker so the policy request reaches the TUI prompt intact.
    if (agent.isPermissionPipelineEnabled()) {
      agent.setPipelineApprovalBroker(getNativeBroker());
    }

    const onStep = (step: StepResult): void => {
      if (step.type === 'text_delta' && step.content) {
        streamingTextRef.current += step.content;
        textFlush.schedule();
      } else if (step.type === 'text' && step.content != null) {
        // Non-streaming fallback (defensive; stream mode emits text_delta).
        commitStreaming();
        feedRef.current.appendEntry({ kind: 'assistant', content: step.content });
      } else if (step.type === 'tool_progress' && step.content != null) {
        // Live tool output (e.g. streaming shell stdout). Accumulate into a
        // streamingTool block rendered outside <Static> so it repaints per chunk.
        if (streamingToolRef.current) {
          streamingToolRef.current.output += step.content;
        } else {
          streamingToolRef.current = {
            name: step.name ?? 'tool',
            args: step.args ?? {},
            output: step.content,
          };
        }
        toolFlush.schedule();
      } else if (step.type === 'tool_call' && step.toolCall) {
        commitStreaming();
        streamingToolRef.current = null;
        toolFlush.flushNow();
        const tc = step.toolCall;
        // manage_todos updates the persistent todo panel (not the feed).
        if (tc.name === 'manage_todos') {
          try {
            const parsed = JSON.parse(tc.result);
            if (Array.isArray(parsed)) setLatestTodos(parsed);
          } catch { /* ignore parse error; todos survive in feed */ }
          return;
        }
        // render_widget mounts a live widget block via the widget host.
        if (tc.name === 'render_widget' && widgetHost) {
          try {
            const meta = step.metadata as { spec: WidgetSpec } | undefined;
            if (meta?.spec) {
              widgetHost.mount(meta.spec);
            }
          } catch (err) { /* ignore malformed widget; degrade gracefully */ }
          return;
        }
        feedRef.current.appendEntry({
          kind: 'tool',
          name: tc.name,
          args: tc.args,
          status: 'ok',
          output: tc.result,
          durationMs: tc.duration,
          metadata: step.metadata,
        });
      }
    };

    try {
      const result: ChatResult = await agent.chat(
        resolvedInput,
        signal,
        approveTool,
        onStep,
        providerFactory,
      );
      commitStreaming(); // commit the final assistant message if any
      if (result.finishReason === 'error' && result.error) {
        feedRef.current.appendEntry({ kind: 'error', message: result.error });
      }
      if (result.usage) {
        setUsage((u) => ({
          totalPromptTokens: u.totalPromptTokens + (result.usage?.promptTokens ?? 0),
          totalCompletionTokens: u.totalCompletionTokens + (result.usage?.completionTokens ?? 0),
          totalCost: u.totalCost + (result.usage?.cost ?? 0),
          requestCount: u.requestCount + 1,
        }));
        // contextTokens reflects the LAST request's prompt size (actual
        // context-window usage), not the cumulative sum across all steps.
        setContextTokens(result.contextTokens ?? result.usage?.promptTokens ?? 0);
      }
    } catch (error) {
      commitStreaming();
      const message = error instanceof Error ? error.message : String(error);
      feedRef.current.appendEntry({ kind: 'error', message });
    } finally {
      // Flush any pending throttled updates before completing.
      textFlush.flushNow();
      toolFlush.flushNow();
      // Unblock the loop if the agent was aborted mid-approval. The object
      // shape is valid for both the native selection and legacy decision.
      if (resolverRef.current) {
        resolverRef.current({ approved: false, reason: 'user-denied' });
        resolverRef.current = null;
      }
      setPendingPermission(null);
      // The native seam is installed per chat; clear it on completion.
      agent.setPipelineApprovalBroker(undefined);
      setIsRunning(false);
    }
  }, [agent, commitStreaming, textFlush, toolFlush, widgetHost, getNativeBroker]);

  const resolvePermission = useCallback((selection: TuiApprovalSelection | ApprovalDecision): void => {
    const resolve = resolverRef.current;
    if (resolve) {
      resolverRef.current = null;
      setPendingPermission(null);
      resolve(selection);
    }
  }, []);

  const abort = useCallback((): void => {
    // A pending approval is resolved as a deny so the loop unblocks before
    // abort. Object shape is valid for both native and legacy resolvers.
    if (resolverRef.current) {
      resolverRef.current({ approved: false, reason: 'user-denied' });
      resolverRef.current = null;
      setPendingPermission(null);
    }
    textFlush.flushNow();
    toolFlush.flushNow();
    agent.abort();
  }, [agent, textFlush, toolFlush]);

  const resetTodos = useCallback((): void => setLatestTodos(null), []);
  const restoreTodos = useCallback((todos: Todo[] | null): void => setLatestTodos(todos), []);

  return { isRunning, pendingPermission, streamingText, streamingTool, usage, contextTokens, latestTodos, submit, resolvePermission, abort, resetTodos, restoreTodos };
}
