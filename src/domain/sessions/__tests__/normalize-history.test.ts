/**
 * Send-time history normalization (021-4 W150, D3 option a).
 *
 * A failed turn leaves its persisted user message dangling; on retry the
 * model input must alternate roles with each user text appearing exactly
 * once — without destroying the stored crash-recovery copy.
 */

import { describe, it, expect } from "vitest";
import { normalizeHistoryForSend } from "../normalize-history.js";
import type { Message } from "../../../foundations/types.js";

function msg(role: "user" | "assistant" | "system", content: string): Message {
  return { id: `${role}-${content}`, role, content, timestamp: 0 };
}

function canonicalText(m: any): string {
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    return m.content.map((c: any) => c.text ?? "").join("");
  }
  return m.text ?? "";
}

describe("normalizeHistoryForSend (W150)", () => {
  it("drops a trailing un-answered user orphan before the new prompt", () => {
    const input = [msg("user", "q"), msg("user", "q")];
    const out = normalizeHistoryForSend(input);
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe("q");
  });

  it("keeps roles alternating when a dangling orphan precedes the retry", () => {
    const input = [
      msg("user", "first"),
      msg("assistant", "answer"),
      msg("user", "dangling"),
      msg("user", "retry"),
    ];
    const out = normalizeHistoryForSend(input);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(out[2].content).toBe("retry");
  });

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

  it("leaves empty and well-formed histories unchanged", () => {
    expect(normalizeHistoryForSend([])).toEqual([]);
    const wellFormed = [msg("user", "hi"), msg("assistant", "hello"), msg("user", "bye")];
    expect(normalizeHistoryForSend(wellFormed)).toEqual(wellFormed);
  });

  it("does not mutate the input array (stored crash-recovery copy stays intact)", () => {
    const input = [msg("user", "q"), msg("user", "q")];
    const snapshot = [...input];
    normalizeHistoryForSend(input);
    expect(input).toEqual(snapshot);
  });
});
