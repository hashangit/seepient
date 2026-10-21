import { describe, expect, it } from "vitest";
import type { Message } from "../../../foundations/types.js";
import { ContextBudgetExceededError } from "../../../foundations/errors.js";
import { applyContextSeam, estimateInputTokens } from "../context-seam.js";

function msg(partial: Partial<Message> & { id: string; role: Message["role"]; content: string }): Message {
  return { timestamp: 0, ...partial };
}

describe("applyContextSeam (spec 029 FR-039/040)", () => {
  const history: Message[] = [
    msg({ id: "u1", role: "user", content: "first question ".repeat(60) }),
    msg({ id: "a1", role: "assistant", content: "first answer".repeat(100), toolCalls: [{ id: "t1", name: "lookup", arguments: {} }] }),
    msg({ id: "t1r", role: "tool", content: "tool says hi", toolCallId: "t1" }),
    msg({ id: "u2", role: "user", content: "second question" }),
  ];

  it("retrieval and cache-aware send the caller's history untouched", () => {
    for (const strategy of ["retrieval", "cache-aware"] as const) {
      const applied = applyContextSeam(history, { strategy });
      expect(applied).toEqual(history);
    }
  });

  it("current keeps only the protected current request", () => {
    const applied = applyContextSeam(history, { strategy: "current" });
    expect(applied).toEqual([history[3]]);
  });

  it("snapshots shortens old free text but preserves tool protocol and the protected request", () => {
    const applied = applyContextSeam(history, { strategy: "snapshots" });
    expect(applied).toHaveLength(4);
    // Assistant with tool calls + its tool result pass untouched (pairing).
    expect(applied[1].content).toBe(history[1].content);
    expect(applied[2].content).toBe("tool says hi");
    // Old user text is snapshot-shortened with the marker.
    expect(applied[0].content).toContain("… snapshot shortened; read original …");
    // Protected current request is never shortened.
    expect(applied[3].content).toBe("second question");
  });

  it("replaces history through the compaction cursor with the summary", () => {
    const applied = applyContextSeam(history, {
      compaction: { cursorMessageId: "t1r", summary: "summary of the first exchange" },
    });
    expect(applied).toHaveLength(2);
    expect(applied[0].role).toBe("user");
    expect(applied[0].content).toBe("summary of the first exchange");
    expect(applied[1]).toEqual(history[3]);
    // The input array itself is untouched (original product history authority).
    expect(history).toHaveLength(4);
  });

  it("rejects a cursor that names no row in this call's history", () => {
    expect(() => applyContextSeam(history, { compaction: { cursorMessageId: "nope", summary: "x" } })).toThrow(
      /COMPACTION_CURSOR_NOT_FOUND/,
    );
  });

  it("overflow surfaces the typed budget error, never quiet truncation", () => {
    const big = msg({ id: "big", role: "user", content: "x".repeat(4000) });
    expect(() => applyContextSeam([big], { maxInputTokens: 100 })).toThrow(ContextBudgetExceededError);
    try {
      applyContextSeam([big], { maxInputTokens: 100 });
      expect.unreachable();
    } catch (error) {
      const typed = error as ContextBudgetExceededError;
      expect(typed.code).toBe("CONTEXT_BUDGET_EXCEEDED");
      expect(typed.estimatedTokens).toBeGreaterThan(100);
      expect(typed.budgetTokens).toBe(100);
    }
  });

  it("counts images in the budget estimate", () => {
    const withImage = msg({
      id: "u",
      role: "user",
      content: "look",
      images: [{ data: "AAAA", mimeType: "image/png" }],
    });
    expect(estimateInputTokens([withImage])).toBe(Math.ceil(4 / 4) + 1000);
  });
});
