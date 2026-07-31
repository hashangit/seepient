/**
 * session-export — format a persisted session for export.
 *
 * Two formats:
 * - `formatJson` — the full SessionData as pretty-printed JSON (lossless,
 *   machine-readable, re-importable).
 * - `formatTranscript` — a human-readable Markdown transcript rendering each
 *   message with its role, tool-call names/args, and results.
 *
 * Both are pure functions over SessionData — no I/O, no deps — so they're
 * trivially testable.
 */

import type { SessionData } from '../../foundations/types.js';

/** Lossless JSON dump of the full session record. */
export function formatJson(session: SessionData): string {
  return JSON.stringify(session, null, 2);
}

/**
 * Human-readable Markdown transcript. Tool calls within an assistant message
 * render as sub-sections; standalone role:"tool" results are joined by
 * toolCallId (the same join the feed-serializer does for the TUI display).
 */
export function formatTranscript(session: SessionData): string {
  const created = new Date(session.createdAt).toISOString();
  const lines: string[] = [
    `# Session ${session.id.slice(0, 8)}`,
    '',
    `Created: ${created}`,
    `Messages: ${session.messages.length}`,
    session.provider ? `Provider: ${session.provider}` : '',
    session.model ? `Model: ${session.model}` : '',
    '',
    '---',
    '',
  ].filter((l) => l !== '' || true);

  // Index tool results by toolCallId for rendering alongside the call.
  const toolResults = new Map<string, string>();
  for (const m of session.messages) {
    if (m.role === 'tool' && m.toolCallId) toolResults.set(m.toolCallId, m.content);
  }

  for (const m of session.messages) {
    if (m.role === 'system') continue;
    if (m.role === 'user') {
      lines.push('## User', '', m.content, '');
    } else if (m.role === 'assistant') {
      if (m.content) lines.push('## Assistant', '', m.content, '');
      if (m.toolCalls) {
        for (const tc of m.toolCalls) {
          const result = tc.result ?? toolResults.get(tc.id);
          lines.push(`### Tool: ${tc.name}`, '');
          lines.push('```json', JSON.stringify(tc.arguments, null, 2), '```', '');
          if (result != null) {
            lines.push('**Result:**', '', '```', result, '```', '');
          }
        }
      }
    }
  }

  return lines.join('\n');
}
