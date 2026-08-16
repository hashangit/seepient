import { describe, it, expect } from "vitest";
import { AggregateInferenceAdapter } from "../aggregate-adapter.js";
import { PiLanguageRaw } from "../../../vendors/pi-ai/pi-language-raw.js";
import { OpenAIImageRaw } from "../../../vendors/openai/openai-image-raw.js";
import { GoogleImageRaw } from "../../../vendors/google/google-image-raw.js";
import type { InferenceTarget } from "../../../foundations/contracts/backend-ports.js";
import type { CredentialHandle } from "../../../foundations/contracts/credential-store.js";
import { InferenceError } from "../../../foundations/errors.js";

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
      stream: async function* () {
        yield { type: "text_start" };
        yield { type: "text_delta", content: "Streaming contract step" };
        yield { type: "text_end" };
        yield {
          type: "done",
          message: { usage: { promptTokens: 3, completionTokens: 4 } },
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

    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    expect((errorEvent as any).error.code).toBe("timeout");
  });
});
