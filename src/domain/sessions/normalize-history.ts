/**
 * Send-time history normalization (021-4 W150, D3 option a).
 *
 * A turn that fails mid-generation leaves its persisted user message
 * dangling (deliberate 0.6.1 crash-recovery design). On retry, the model
 * would otherwise receive two consecutive user messages, which strict
 * providers (Anthropic) reject — permanently breaking the session.
 *
 * Normalization happens ONLY on the model-input copy, never on the stored
 * history: crash-recovery data survives until a turn actually succeeds.
 */

import type { Message } from "../../foundations/types.js";

/**
 * Normalize assembled model input:
 *  1. Drop a trailing un-answered user orphan — a user message immediately
 *     followed by the new (also user) turn prompt. The new prompt wins, so
 *     a same-text retry contains each user text exactly once.
 *  2. Collapse any remaining consecutive same-role user messages mid-history
 *     by merging their contents with a blank line.
 *
 * System / assistant / tool-message ordering is untouched.
 */
export function normalizeHistoryForSend(messages: Message[]): Message[] {
  if (messages.length < 2) return messages;

  const out: Message[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const next = messages[i + 1];
    const prev = out[out.length - 1];

    // Rule 1: a user message directly followed by another user message AND
    // at the end of the list is a dangling turn orphan — the final prompt
    // supersedes it.
    if (
      msg.role === "user" &&
      next?.role === "user" &&
      i + 1 === messages.length - 1
    ) {
      continue;
    }

    // Rule 2: merge any other consecutive user messages.
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
