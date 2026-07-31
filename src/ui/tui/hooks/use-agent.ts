/**
 * use-agent — agent run state for the TUI.
 *
 * Drives `Agent.chat(input, signal, approveTool, permissionLevel, onStep)`,
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

import { useCallback, useRef, useState } from 'react';
import { Agent, type ChatResult } from '../../../transport/cli/agent.js';
import type { ApproveToolFn, ApprovalContext, ApprovalDecision, PermissionLevel, StepResult, CumulativeUsage } from '../../../foundations/types.js';
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

export interface StreamingToolView {
  name: string;
  args: Record<string, unknown>;
  output: string;
}

export interface AgentApi {
  isRunning: boolean;
  pendingPermission: PendingPermissionView | null;
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
  submit: (input: string) => Promise<void>;
  resolvePermission: (decision: ApprovalDecision) => void;
  abort: () => void;
  resetTodos: () => void;
  /** Restore the persistent todo panel (e.g. from a resumed session). */
  restoreTodos: (todos: Todo[] | null) => void;
}

export interface UseAgentArgs {
  agent: Agent;
  feed: FeedApi;
  permissionLevel?: PermissionLevel;
  widgetHost?: WidgetHost;
}

export function useAgent({ agent, feed, permissionLevel, widgetHost }: UseAgentArgs): AgentApi {
  const [isRunning, setIsRunning] = useState(false);
  const [pendingPermission, setPendingPermission] = useState<PendingPermissionView | null>(null);
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
  const permissionLevelRef = useRef(permissionLevel);
  permissionLevelRef.current = permissionLevel;
  const resolverRef = useRef<((value: ApprovalDecision) => void) | null>(null);
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

  const submit = useCallback(async (input: string): Promise<void> => {
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
      setPendingPermission({ toolName: call.name, args: call.args, approvalContext: call.approvalContext });

      const decision = await new Promise<ApprovalDecision>((resolve) => {
        resolverRef.current = resolve;
      });

      resolverRef.current = null;
      setPendingPermission(null);
      return decision;
    };

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
        permissionLevelRef.current,
        onStep,
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
      // Unblock the loop if the agent was aborted mid-approval.
      if (resolverRef.current) {
        resolverRef.current(false);
        resolverRef.current = null;
      }
      setPendingPermission(null);
      setIsRunning(false);
    }
  }, [agent, commitStreaming, textFlush, toolFlush, widgetHost]);

  const resolvePermission = useCallback((decision: ApprovalDecision): void => {
    const resolve = resolverRef.current;
    if (resolve) {
      resolverRef.current = null;
      resolve(decision);
    }
  }, []);

  const abort = useCallback((): void => {
    // A pending approval is resolved as a deny so the loop unblocks before abort.
    if (resolverRef.current) {
      resolverRef.current(false);
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
