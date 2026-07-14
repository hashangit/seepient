/**
 * feed-serializer — rebuild the TUI feed from persisted messages.
 *
 * When a session is resumed, its `Message[]` history must be projected back
 * into the `FeedEntry` union the feed renders. During a live run, entries are
 * built imperatively from `StepResult` callbacks (see use-agent.ts); on replay
 * there is no loop, so this pure function does the equivalent mapping in one
 * pass.
 *
 * `manage_todos` is handled exactly like the live path: it updates the
 * persistent todo panel, NOT the feed. The most-recent `manage_todos` result is
 * returned as `latestTodos` so the caller (session resume) can restore the
 * pinned panel — otherwise the todos would only appear as a scrolling box.
 *
 * Tool results are NOT stored on the assistant message's toolCalls[].result —
 * runAgentLoop emits them as separate role:"tool" messages linked by
 * toolCallId (agent-loop.ts:459). This serializer joins the two so replayed
 * tool blocks show their output. Tool durationMs is not persisted, so replayed
 * blocks render without duration (cosmetic only).
 */

import type { Message } from '../../../core/types.js';
import type { FeedEntryInput } from './types.js';
import type { Todo } from './components/goal-status.js';

export interface RebuiltFeed {
  entries: FeedEntryInput[];
  /** The most-recent manage_todos result (the current todo list), or null. */
  latestTodos: Todo[] | null;
}

export function messagesToFeedEntries(messages: Message[]): RebuiltFeed {
  // Index tool results by toolCallId for O(1) lookup when rendering tool calls.
  const toolResults = new Map<string, string>();
  for (const m of messages) {
    if (m.role === 'tool' && m.toolCallId) {
      toolResults.set(m.toolCallId, m.content);
    }
  }

  const entries: FeedEntryInput[] = [];
  let latestTodos: Todo[] | null = null;
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'user') {
      entries.push({ kind: 'user', content: m.content });
    } else if (m.role === 'assistant') {
      if (m.content) entries.push({ kind: 'assistant', content: m.content });
      if (m.toolCalls) {
        for (const tc of m.toolCalls) {
          const result = tc.result ?? toolResults.get(tc.id);
          // manage_todos feeds the persistent panel, not the scrollback (mirrors
          // the live intercept in use-agent). Track the latest; skip the feed.
          if (tc.name === 'manage_todos') {
            if (result) {
              try {
                const parsed = JSON.parse(result);
                if (Array.isArray(parsed)) latestTodos = parsed as Todo[];
              } catch { /* ignore parse error */ }
            }
            continue;
          }
          // render_widget → rebuild as a finalized, non-interactive widget block.
          if (tc.name === 'render_widget' && tc.arguments) {
            try {
              const args = typeof tc.arguments === 'string'
                ? JSON.parse(tc.arguments)
                : tc.arguments;
              const spec = args as Record<string, unknown>;
              if (spec && typeof spec.id === 'string' && typeof spec.kind === 'string') {
                entries.push({
                  kind: 'block' as const,
                  blockKind: 'widget' as const,
                  props: spec,
                  finalized: true,
                });
                continue;
              }
            } catch { /* fall through to generic tool block */ }
          }
          entries.push({
            kind: 'tool',
            name: tc.name,
            args: tc.arguments,
            status: result != null ? 'ok' : 'fail',
            output: result,
          });
        }
      }
    }
    // role: 'tool' messages are consumed above via the toolResults index —
    // they are provider-facing duplicates, not feed entries.
  }
  return { entries, latestTodos };
}
