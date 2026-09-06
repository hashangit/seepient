/**
 * Send-time history normalization (021-4 W150, revised by review F1).
 *
 * Dangling failed-turn drafts are resolved at their source (store-level
 * `resolveTrailingDraft` / SDK `resolveTrailingUserDraft`), so the send-time
 * normalizer is a LEGACY FALLBACK only: it merges consecutive same-role user
 * messages from pre-021-4 stored sessions so strict providers still accept
 * the model input.
 */

import { describe, it, expect } from "vitest";
import { normalizeHistoryForSend } from "../normalize-history.js";
import type { Message } from "../../../foundations/types.js";

function msg(role: "user" | "assistant" | "system", content: string): Message {
  return { id: `${role}-${content}`, role, content, timestamp: 0 };
}

describe("normalizeHistoryForSend (legacy fallback)", () => {
  it("merges mid-history consecutive user messages, keeping each text once", () => {
    const input = [
      msg("user", "a"),
      msg("user", "b"),
      msg("assistant", "ok"),
      msg("user", "c"),
    ];
    const out = normalizeHistoryForSend(input);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(out[0].content).toBe("a\n\nb");
    expect(out[2].content).toBe("c");
  });

  it("merges a legacy trailing user pair as the last resort", () => {
    // Only reachable when the draft was not resolved at the source
    const out = normalizeHistoryForSend([msg("user", "a"), msg("user", "b")]);
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe("a\n\nb");
  });

  it("leaves empty and well-formed histories unchanged", () => {
    expect(normalizeHistoryForSend([])).toEqual([]);
    const wellFormed = [msg("user", "hi"), msg("assistant", "hello"), msg("user", "bye")];
    expect(normalizeHistoryForSend(wellFormed)).toEqual(wellFormed);
  });

  it("does not mutate the input array", () => {
    const input = [msg("user", "a"), msg("user", "b")];
    const snapshot = [...input];
    normalizeHistoryForSend(input);
    expect(input).toEqual(snapshot);
  });
});
