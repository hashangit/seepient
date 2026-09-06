/**
 * Send-time history normalization through the transports (021-4 W150, D3a).
 *
 * A failed turn leaves its persisted user message dangling; on retry the
 * model input must alternate roles with each user text appearing exactly
 * once — through serverGenerateText (REST/WS) and createSeepient (SDK).
 */

import { describe, it, expect } from "vitest";
import { serverGenerateText } from "../http/server-core.js";
import { createSeepient } from "../sdk/seepient.js";
import { createMockRuntime } from "../../domain/__tests__/test-doubles.js";
import { MemoryPersistenceBackend } from "../../domain/sessions/session-store.js";
import { normalizeHistoryForSend } from "../../domain/sessions/normalize-history.js";
import type { Message } from "../../foundations/types.js";

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

/** Mock runtime that records canonical model input per call. */
function recordingRuntime(failFirst: boolean) {
  const seenMessages: Array<Array<{ role: string; text: string }>> = [];
  const runtime = {
    createTurnSnapshot: async () => ({
      revision: 1,
      createdAt: new Date().toISOString(),
      catalog: [],
      config: {} as any,
      assignments: {} as any,
    }),
    resolvePlan: async () => ({
      selectedTarget: { providerAccount: "mock", model: "mock-model" } as any,
      failureTargets: [],
    }),
    executeLanguage: async function* (_plan: unknown, req: any) {
      seenMessages.push(req.messages.map((m: any) => ({ role: m.role, text: canonicalText(m) })));
      if (failFirst) {
        failFirst = false;
        yield {
          type: "error",
          error: { code: "PROVIDER_ERROR", message: "boom", retryable: false },
        };
        return;
      }
      yield { type: "content_block_start", index: 0, block: { type: "text", text: "" } };
      yield {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "recovered" },
      };
      yield { type: "content_block_stop", index: 0 };
    },
  };
  return { runtime, seenMessages };
}

describe("normalizeHistoryForSend — pure re-export sanity (W150 unit tests live in domain)", () => {
  it("drops a trailing un-answered user orphan", () => {
    expect(normalizeHistoryForSend([msg("user", "q"), msg("user", "q")]))
      .toEqual([msg("user", "q")]);
  });
});

describe("W150 — serverGenerateText normalizes dangling history (REST/WS)", () => {
  it("turn-2 model input alternates roles with each user text exactly once", async () => {
    const { runtime, seenMessages } = recordingRuntime(false);

    // Turn 1 failed mid-generation: the store holds a dangling user message.
    const history = [msg("user", "What is the capital of France?")];

    await serverGenerateText({
      message: "What is the capital of France?",
      history,
      runtime: runtime as any,
      tools: [],
      // Suppress ambient skill discovery so no system message is prepended.
      skills: ["no-such-skill"],
    });

    const canonical = seenMessages[0];
    const roles = canonical.map((m) => m.role);
    expect(roles).toEqual(["user"]);
    const texts = canonical.filter((m) => m.role === "user").map((m) => m.text);
    expect(texts.filter((t) => t.includes("capital of France"))).toHaveLength(1);
  });
});

describe("W150 — createSeepient.chat normalizes dangling turns (SDK)", () => {
  it("a retry after a failed turn sends alternating roles to the provider", async () => {
    const { runtime, seenMessages } = recordingRuntime(true);

    const agent = await createSeepient({
      runtime: runtime as any,
      persist: new MemoryPersistenceBackend(),
      tools: [],
      skills: false,
    });

    // Turn 1 fails mid-generation; the user message is persisted (crash recovery).
    await expect(agent.chat("Hello there")).rejects.toThrow(/boom/);
    const historyAfterFailure = agent.getHistory().filter((m: Message) => m.role === "user");
    expect(historyAfterFailure).toHaveLength(1); // crash-recovery data intact

    // Turn 2 retries: the model must see alternating roles, text once.
    const reply = await agent.chat("Hello there");
    expect(reply.text).toBe("recovered");

    const turn2Input = seenMessages[1];
    // createSeepient always carries its own system message; the model input
    // must alternate system → user with the retry text appearing exactly once.
    expect(turn2Input.map((m) => m.role)).toEqual(["system", "user"]);
    expect(turn2Input.filter((m) => m.text === "Hello there")).toHaveLength(1);
  });
});
