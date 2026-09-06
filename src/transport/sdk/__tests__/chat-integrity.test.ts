/**
 * SDK chat integrity (021-4 W151).
 *
 * A resolved `finishReason:"error"` turn must not leave an empty assistant
 * row in the persisted history — the dangling user message stays (crash
 * recovery), the empty assistant does not.
 */

import { describe, it, expect } from "vitest";
import { createSeepient } from "../seepient.js";
import { createMockRuntime } from "../../../domain/__tests__/test-doubles.js";
import { MemoryPersistenceBackend } from "../../../domain/sessions/session-store.js";

function errorThenOkRuntime() {
  let failed = false;
  return {
    runtime: {
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
      executeLanguage: async function* () {
        if (!failed) {
          failed = true;
          yield {
            type: "error",
            error: { code: "PROVIDER_ERROR", message: "resolved loop failure", retryable: false },
          };
          return;
        }
        yield { type: "start", resolvedModel: { providerAccount: "m", modelId: "mock-model" } };
        yield { type: "content_block_start", index: 0, block: { type: "text", text: "" } };
        yield {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "recovered" },
        };
        yield { type: "content_block_stop", index: 0 };
      },
    },
  };
}

describe("W151 — chatStream never persists an empty assistant on resolved errors", () => {
  it("an error after a tool call keeps the assistant tool-call row and its tool result (no orphans)", async () => {
    // The W151 empty-assistant filter used to drop the assistant message that
    // carries the tool calls (content is legitimately empty), orphaning the
    // tool result — every provider then rejects the session forever.
    const runtime = createMockRuntime([
      { toolCalls: [{ id: "tc1", name: "get_current_datetime", arguments: {} }] },
      { error: { code: "PROVIDER_ERROR", message: "call failed after tool" } },
    ]);

    const backend = new MemoryPersistenceBackend();
    const agent = await createSeepient({
      runtime,
      persist: backend,
      tools: ["get_current_datetime"],
      skills: false,
    });

    await expect(agent.chat("what time is it")).rejects.toThrow(/call failed after tool/);
    await new Promise((r) => setTimeout(r, 20));

    const stored = await backend.load(agent.sessionId);
    const roles = stored!.messages.map((m) => m.role);
    // Assistant (with toolCalls) and its tool result must BOTH survive
    expect(roles).toContain("tool");
    const assistantWithTools = stored!.messages.find(
      (m) => m.role === "assistant" && m.toolCalls?.length,
    );
    expect(assistantWithTools).toBeDefined();
    const toolMsg = stored!.messages.find((m) => m.role === "tool");
    expect(toolMsg?.toolCallId).toBe("tc1");
  });

  it("a resolved-error stream leaves only the user message persisted", async () => {
    const backend = new MemoryPersistenceBackend();
    const { runtime } = errorThenOkRuntime();

    const agent = await createSeepient({
      runtime: runtime as any,
      persist: backend,
      tools: [],
      skills: false,
    });

    const stream = await agent.chatStream("turn that fails");
    const finishReason = await stream.finishReason;
    expect(finishReason).toBe("error");

    // Allow the finally-block persistence to land
    await new Promise((resolve) => setTimeout(resolve, 20));

    const stored = await backend.load(agent.sessionId);
    expect(stored).not.toBeNull();
    const roles = stored!.messages.map((m) => m.role);
    expect(roles).toEqual(["system", "user"]);
  });

  it("the next successful stream persists a real assistant row", async () => {
    const backend = new MemoryPersistenceBackend();
    const { runtime } = errorThenOkRuntime();

    const agent = await createSeepient({
      runtime: runtime as any,
      persist: backend,
      tools: [],
      skills: false,
    });

    const failing = await agent.chatStream("turn that fails");
    expect(await failing.finishReason).toBe("error");
    await new Promise((resolve) => setTimeout(resolve, 20));

    const ok = await agent.chatStream("turn that works");
    expect(await ok.finishReason).toBe("stop");
    expect(await ok.fullText).toBe("recovered");
    await new Promise((resolve) => setTimeout(resolve, 20));

    const stored = await backend.load(agent.sessionId);
    const roles = stored!.messages.map((m) => m.role);
    // F1: the next turn RESOLVED the dangling draft — the failed prompt was
    // superseded, so the store shows a clean alternating sequence with no
    // empty assistant rows.
    expect(roles.filter((r) => r === "assistant")).toHaveLength(1);
    expect(roles).toEqual(["system", "user", "assistant"]);
    const assistant = stored!.messages.find((m) => m.role === "assistant");
    expect(assistant?.content).toBe("recovered");
  });
});
