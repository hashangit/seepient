import { describe, it, expect } from "vitest";
import { AggregateInferenceAdapter } from "../aggregate-adapter.js";
import { PiLanguageRaw } from "../../../vendors/pi-ai/pi-language-raw.js";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { InferenceTarget } from "../../../foundations/contracts/backend-ports.js";
import type { CredentialHandle } from "../../../foundations/contracts/credential-store.js";

function createMockCredential(): CredentialHandle {
  return {
    id: "cred-test",
    ref: { kind: "env", name: "TEST_KEY" },
    activeLeaseCount: 0,
    async isResolvable() {
      return true;
    },
    acquireLease() {
      return {
        leaseId: "lease-test",
        isReleased: false,
        async secret() {
          return { kind: "api_key", value: "sk-test" };
        },
        async release() {},
      };
    },
  };
}

describe("Adapter contract tests (QS-P3.10)", () => {
  const credential = createMockCredential();

  it("handles streaming start, deltas, and finish events sequentially", async () => {
    const mockModels: any = {
      getModel: () => ({ id: "gpt-4o", provider: "openai" }),
      stream: async function* (): AsyncIterable<AssistantMessageEvent> {
        const dummyMsg: any = { role: "assistant", content: [] };
        yield { type: "start", partial: dummyMsg };
        yield { type: "text_start", contentIndex: 0, partial: dummyMsg };
        yield { type: "text_delta", contentIndex: 0, delta: "Streaming contract step", partial: dummyMsg };
        yield { type: "text_end", contentIndex: 0, content: "Streaming contract step", partial: dummyMsg };
        yield {
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            api: "openai-completions",
            provider: "openai",
            model: "gpt-4o",
            content: [{ type: "text", text: "Streaming contract step" }],
            stopReason: "stop",
            timestamp: Date.now(),
            usage: {
              input: 3,
              output: 4,
              totalTokens: 7,
              cacheRead: 0,
              cacheWrite: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          },
        };
      },
    };

    const adapter = new AggregateInferenceAdapter({
      language: new PiLanguageRaw(mockModels),
    });

    const target: InferenceTarget = {
      providerAccount: "acc-1",
      upstreamProvider: "openai",
      model: "gpt-4o",
      credential,
    };

    const bound = await adapter.bind(target);
    expect(bound.language).toBeDefined();

    const events = [];
    for await (const ev of bound.language!.stream({
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    })) {
      events.push(ev);
    }

    expect(events[0].type).toBe("start");
    expect(events[1].type).toBe("content_block_start");
    expect(events[2].type).toBe("content_block_delta");
    expect(events[3].type).toBe("content_block_stop");
    expect(events[4].type).toBe("finish");
  });

  it("propagates timeout and abort signal correctly in streaming", async () => {
    const ac = new AbortController();
    ac.abort(new Error("Pre-aborted test"));

    const adapter = new AggregateInferenceAdapter();
    const target: InferenceTarget = {
      providerAccount: "acc-1",
      upstreamProvider: "openai",
      model: "gpt-4o",
      credential,
    };

    const bound = await adapter.bind(target);
    const events = [];
    for await (const ev of bound.language!.stream(
      { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
      { signal: ac.signal },
    )) {
      events.push(ev);
    }

    const abortEvent = events.find((e) => e.type === "abort");
    expect(abortEvent).toBeDefined();
    expect((abortEvent as any).reason).toBe("user");
  });
});
