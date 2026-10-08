/**
 * StreamManager contract (021-4 review F2/F3 + round-3 P2-1).
 *
 * F2 — a failed turn must be observable: fullText rejects (parity with the
 *      non-streaming throw), and textStream throws the same error after
 *      draining the deltas already queued — a delta-only consumer must not
 *      see a silent zero-output completion on a failed turn.
 * F3 — SSE tool_result events report the actual execution outcome instead of
 *      a hardcoded success.
 */

import { describe, it, expect } from "vitest";
import { StreamManager } from "../stream-manager.js";
import { SeepientError } from "../../../foundations/errors.js";
import type { StepResult } from "../../../foundations/types.js";

function toolCallStep(result: string): StepResult {
  return {
    type: "tool_call",
    toolCall: { id: "call-1", name: "web_search", args: {}, result },
    timestamp: Date.now(),
  } as unknown as StepResult;
}

async function drainSse(stream: ReadableStream): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value);
  }
  return out;
}

describe("F2 — failed turns are observable on fullText AND textStream", () => {
  it("rejectText surfaces the error to callers awaiting fullText", async () => {
    const mgr = new StreamManager();
    mgr.enqueueText("partial");
    mgr.resolveUsage({ promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0 });
    mgr.resolveFinish("error");
    mgr.rejectText(new SeepientError("provider down", "PROVIDER_ERROR", true));
    mgr.complete();

    await expect(mgr.fullText).rejects.toThrow(/provider down/);
    await expect(mgr.finishReason).resolves.toBe("error");
  });

  it("textStream drains queued deltas, then throws the turn error (round-3 P2-1)", async () => {
    const mgr = new StreamManager();
    mgr.enqueueText("partial");
    mgr.resolveUsage({ promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0 });
    mgr.resolveFinish("error");
    mgr.rejectText(new SeepientError("provider down", "PROVIDER_ERROR", true));
    mgr.complete();

    const chunks: string[] = [];
    await expect(
      (async () => {
        for await (const chunk of mgr.textStream) chunks.push(chunk);
      })(),
    ).rejects.toThrow(/provider down/);
    expect(chunks).toEqual(["partial"]);
  });

  it("textStream still completes normally on a successful turn", async () => {
    const mgr = new StreamManager();
    mgr.enqueueText("all ");
    mgr.enqueueText("good");
    mgr.resolveText("all good");
    mgr.resolveUsage({ promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0 });
    mgr.resolveFinish("stop");
    mgr.complete();

    const chunks: string[] = [];
    for await (const chunk of mgr.textStream) chunks.push(chunk);
    expect(chunks).toEqual(["all ", "good"]);
  });

  it("fullText rejection does not become an unhandled rejection when unobserved", async () => {
    const mgr = new StreamManager();
    mgr.rejectText(new Error("nobody awaits me"));
    mgr.complete();
    // Give the event loop a turn — Node would emit unhandledRejection here
    await new Promise((r) => setTimeout(r, 20));
    expect(true).toBe(true);
  });
});

describe("F3 — SSE tool_result reports the real outcome", () => {
  it("marks failed tool outputs as success:false", async () => {
    const mgr = new StreamManager();
    mgr.enqueueStep(toolCallStep("Error: rate limited by upstream"));
    mgr.resolveUsage({ promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0 });
    mgr.resolveFinish("stop");
    mgr.complete();

    const sse = await drainSse(mgr.toSSEStream());
    expect(sse).toContain('"success":false');
  });

  it("keeps successful tool outputs as success:true", async () => {
    const mgr = new StreamManager();
    mgr.enqueueStep(toolCallStep('{"results": []}'));
    mgr.resolveUsage({ promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0 });
    mgr.resolveFinish("stop");
    mgr.complete();

    const sse = await drainSse(mgr.toSSEStream());
    expect(sse).toContain('"success":true');
  });
});
