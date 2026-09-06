/**
 * Send-time history normalization — legacy fallback only (021-4 W150, F1).
 *
 * Dangling failed-turn drafts are resolved at their SOURCE (the server
 * session store's `resolveTrailingDraft` / the SDK's `resolveTrailingUserDraft`)
 * when the next turn starts, so the stored history, the API views, and the
 * model input stay in sync. What can still reach this point are consecutive
 * same-role user messages from pre-021-4 stored sessions or multi-writer
 * histories: strict providers reject consecutive user messages, so those are
 * merged (each text preserved exactly once, joined with a blank line).
 */

import type { Message } from "../../foundations/types.js";

export function normalizeHistoryForSend(messages: Message[]): Message[] {
  if (messages.length < 2) return [...messages];

  const out: Message[] = [];

  for (const msg of messages) {
    const prev = out[out.length - 1];
    if (msg.role === "user" && prev?.role === "user") {
      out[out.length - 1] = {
        ...prev,
        content: `${prev.content}\n\n${msg.content}`,
      };
      continue;
    }
    out.push(msg);
  }

  return out;
}
