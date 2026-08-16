import { describe, it, expect } from "vitest";
import { AggregateInferenceAdapter } from "../../src/capabilities/inference/aggregate-adapter.js";
import { PiLanguageRaw } from "../../src/vendors/pi-ai/pi-language-raw.js";
import { OpenAIImageRaw } from "../../src/vendors/openai/openai-image-raw.js";
import { GoogleImageRaw } from "../../src/vendors/google/google-image-raw.js";
import type { InferenceTarget } from "../../src/foundations/contracts/backend-ports.js";
import type { CredentialHandle } from "../../src/foundations/contracts/credential-store.js";

function createMockCredential(): CredentialHandle {
  return {
    id: "cred-conformance",
    ref: { kind: "env", name: "TEST_KEY" },
    activeLeaseCount: 0,
    async isResolvable() {
      return true;
    },
    acquireLease() {
      return {
        leaseId: "lease-conf",
        isReleased: false,
        async secret() {
          return { kind: "api_key", value: "sk-conformance" };
        },
        async release() {},
      };
    },
  };
}

describe("Adapter-substitution Conformance Suite (QS-P3.12)", () => {
  const credential = createMockCredential();

  it("satisfies language streaming lifecycle invariants", async () => {
    const mockModels: any = {
      getModel: () => ({ id: "gpt-4o", provider: "openai" }),
      stream: async function* () {
        yield { type: "text_start" };
        yield { type: "text_delta", content: "Conformance verified" };
        yield { type: "text_end" };
        yield {
          type: "done",
          message: { usage: { promptTokens: 4, completionTokens: 2 } },
        };
      },
    };

    const adapter = new AggregateInferenceAdapter({
      language: new PiLanguageRaw(mockModels),
    });

    const target: InferenceTarget = {
      providerAccount: "conf-acc",
      upstreamProvider: "openai",
      model: "gpt-4o",
      credential,
    };

    const bound = await adapter.bind(target);
    expect(bound.language).toBeDefined();

    const events = [];
    for await (const ev of bound.language!.stream({
      messages: [{ role: "user", content: [{ type: "text", text: "test" }] }],
    })) {
      events.push(ev);
    }

    // Invariant 1: First event is start
    expect(events[0].type).toBe("start");

    // Invariant 2: Blocks are paired start and stop
    const starts = events.filter((e) => e.type === "content_block_start");
    const stops = events.filter((e) => e.type === "content_block_stop");
    expect(starts.length).toBe(stops.length);

    // Invariant 3: Last event is finish
    const last = events[events.length - 1];
    expect(last.type).toBe("finish");
  });

  it("satisfies image generation result invariants", async () => {
    const mockClient: any = {
      images: {
        generate: async () => ({
          created: 1700000000,
          data: [{ b64_json: "valid-base64", revised_prompt: "revised" }],
        }),
      },
    };

    const adapter = new AggregateInferenceAdapter({
      openaiImage: new OpenAIImageRaw(mockClient),
    });

    const target: InferenceTarget = {
      providerAccount: "conf-acc",
      upstreamProvider: "openai",
      model: "dall-e-3",
      credential,
    };

    const bound = await adapter.bind(target);
    const result = await bound.images!.generate({
      prompt: "Conformance image prompt",
      operation: "generate",
    });

    // Invariant 1: Contains at least 1 image
    expect(result.images.length).toBeGreaterThanOrEqual(1);

    // Invariant 2: Each image has mimeType and either url or base64
    for (const img of result.images) {
      expect(img.mimeType).toBeDefined();
      expect(img.url || img.base64).toBeDefined();
    }
  });
});
