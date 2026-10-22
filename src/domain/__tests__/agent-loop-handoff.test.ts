/**
 * 029 T041 — the mid-loop model-handoff seam (FR-035/D10, executes B-2).
 *
 * On a terminal model-setup failure, the loop consumes the NEXT fallback:
 * onModelChange is awaited as persisted BEFORE the replacement request, the
 * SAME run continues (committed results stand — no whole-run retry), and
 * the applied handoff rides the result.
 */
import { describe, expect, it, vi } from "vitest";
import { runAgentLoop } from "../agent-loop.js";
import { createMockRuntime } from "./test-doubles.js";
import { SeepientError } from "../../foundations/errors.js";

describe("029 S17 — mid-loop model handoff (T041)", () => {
  it("handoff at the failed model-call boundary: onModelChange awaited before the replacement request; no whole-run retry", async () => {
    const callOrder: string[] = [];
    let providerCalls = 0;
    // Runtime: first model fails terminally; after the handoff, the second
    // model succeeds. The mock keys responses by call order.
    let failFirst = true;
    const runtime = {
      describe: () => ({ capabilities: { scripted: false } }),
      createTurnSnapshot: async () => ({}),
      resolvePlan: async () => ({
        selectedTarget: { providerAccount: "account-1", model: failFirst ? "model-a" : "model-b" },
      }),
      async *executeLanguage() {
        providerCalls += 1;
        if (failFirst) {
          failFirst = false;
          callOrder.push("provider-failed");
          yield {
            type: "error" as const,
            error: { code: "PROVIDER_ERROR", message: "model exploded", retryable: false },
          };
          return;
        }
        callOrder.push("provider-succeeded");
        yield { type: "content_block_delta" as const, delta: { type: "text_delta" as const, text: "deployed" } };
        yield { type: "finish" as const, usage: { promptTokens: 1, completionTokens: 1 } };
      },
    } as never;

    const changePersists = vi.fn(async () => {
      // FR-035: the replacement request fires only AFTER persistence.
      callOrder.push("onModelChange-persisted");
    });
    const result = await runAgentLoop({
      runtime,
      messages: [{ id: "m1", role: "user", content: "deploy", timestamp: Date.now() }],
      toolDefs: [],
      maxSteps: 3,
      autoConfirm: true,
      modelHandoff: {
        fallbacks: [{ provider: "other", id: "model-b" }],
        onModelChange: changePersists,
      },
    });

    expect(result.finishReason).toBe("stop");
    expect(result.modelHandoff).toEqual({ fromModel: "model-a", toProvider: "other", toModel: "model-b" });
    // Ordering: the persistence landed BEFORE the replacement provider call.
    expect(callOrder).toEqual(["provider-failed", "onModelChange-persisted", "provider-succeeded"]);
    // Exactly two provider calls (failed + replacement) — no whole-run retry.
    expect(providerCalls).toBe(2);
  });

  it("a rejecting onModelChange refuses the handoff and fails the run (persistence is the gate)", async () => {
    let providerCalls = 0;
    let failFirst = true;
    const runtime = {
      describe: () => ({ capabilities: { scripted: false } }),
      createTurnSnapshot: async () => ({}),
      resolvePlan: async () => ({ selectedTarget: { providerAccount: "account-1" } }),
      async *executeLanguage() {
        providerCalls += 1;
        if (failFirst) {
          failFirst = false;
          yield {
            type: "error" as const,
            error: { code: "PROVIDER_ERROR", message: "model exploded", retryable: false },
          };
          return;
        }
        yield { type: "finish" as const, usage: { promptTokens: 1, completionTokens: 1 } };
      },
    } as never;

    const result = await runAgentLoop({
      runtime,
      messages: [{ id: "m1", role: "user", content: "deploy", timestamp: Date.now() }],
      toolDefs: [],
      maxSteps: 3,
      autoConfirm: true,
      modelHandoff: {
        fallbacks: [{ provider: "other", id: "model-b" }],
        onModelChange: async () => {
          throw new SeepientError("Run lease was lost before the backup model could be used", "LEASE_LOST", false);
        },
      },
    });
    expect(result.finishReason).toBe("error");
    expect(result.error?.code).toBe("MODEL_CHANGE_PERSIST_FAILED");
    // The replacement request never fired.
    expect(providerCalls).toBe(1);
  });

  it("committed results stand: content produced before the failure is kept", async () => {
    let failFirst = true;
    const runtime = {
      describe: () => ({ capabilities: { scripted: false } }),
      createTurnSnapshot: async () => ({}),
      resolvePlan: async () => ({ selectedTarget: { providerAccount: "account-1" } }),
      async *executeLanguage() {
        if (failFirst) {
          failFirst = false;
          yield { type: "content_block_delta" as const, delta: { type: "text_delta" as const, text: "partial " } };
          yield {
            type: "error" as const,
            error: { code: "PROVIDER_ERROR", message: "exploded", retryable: false },
          };
          return;
        }
        yield { type: "content_block_delta" as const, delta: { type: "text_delta" as const, text: "continued" } };
        yield { type: "finish" as const, usage: { promptTokens: 1, completionTokens: 1 } };
      },
    } as never;

    const result = await runAgentLoop({
      runtime,
      messages: [{ id: "m1", role: "user", content: "go", timestamp: Date.now() }],
      toolDefs: [],
      maxSteps: 3,
      autoConfirm: true,
      modelHandoff: {
        fallbacks: [{ provider: "other", id: "model-b" }],
        onModelChange: async () => undefined,
      },
    });
    expect(result.finishReason).toBe("stop");
    const text = result.messages
      .filter((m) => m.role === "assistant")
      .map((m) => m.content as string)
      .join("");
    expect(text).toContain("continued");
  });
});
