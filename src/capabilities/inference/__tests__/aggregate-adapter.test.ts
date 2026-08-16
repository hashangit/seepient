import { describe, it, expect, vi } from "vitest";
import { AggregateInferenceAdapter } from "../aggregate-adapter.js";
import type {
  InferenceTarget,
  LanguageBackend,
  ImageBackend,
} from "../../../foundations/contracts/backend-ports.js";
import type { CredentialHandle } from "../../../foundations/contracts/credential-store.js";
import { CURATED_MODELS } from "../catalog-merge.js";

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
        leaseId: "lease-1",
        isReleased: false,
        async secret() {
          return { kind: "api_key", value: "sk-test" };
        },
        async release() {},
      };
    },
  };
}

describe("AggregateInferenceAdapter (QS-P3.8)", () => {
  const credential = createMockCredential();

  it("selectively binds language and image executors based on catalog capabilities", async () => {
    const adapter = new AggregateInferenceAdapter();

    // 1. Language-only model
    const langTarget: InferenceTarget = {
      providerAccount: "work-openai",
      upstreamProvider: "openai",
      model: "gpt-4o",
      credential,
    };
    const boundLang = await adapter.bind(langTarget);
    expect(boundLang.language).toBeDefined();
    expect(boundLang.images).toBeUndefined();

    // 2. Image-only model
    const imgTarget: InferenceTarget = {
      providerAccount: "work-openai",
      upstreamProvider: "openai",
      model: "dall-e-3",
      credential,
    };
    const boundImg = await adapter.bind(imgTarget);
    expect(boundImg.images).toBeDefined();
    expect(boundImg.language).toBeUndefined();
  });

  it("routes language stream and chat to the configured language backend", async () => {
    const mockLangBackend: LanguageBackend = {
      chatStream: async function* () {
        yield {
          type: "start",
          resolvedModel: { modelId: "gpt-4o", providerAccount: "work" },
        };
        yield {
          type: "finish",
          stopReason: "end_turn",
        };
      },
      chat: async () => ({
        content: [{ type: "text", text: "chat result" }],
        stopReason: "end_turn",
        usage: { promptTokens: 2, completionTokens: 2, totalTokens: 4 },
      }),
    };

    const adapter = new AggregateInferenceAdapter({
      language: mockLangBackend,
    });

    const target: InferenceTarget = {
      providerAccount: "work",
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
    expect(events.length).toBe(2);

    const resp = await bound.language!.chat({
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });
    expect((resp.content[0] as any).text).toBe("chat result");
  });

  it("routes image generation to the appropriate peer backend (OpenAI, Google, Pi)", async () => {
    const mockOpenAI: ImageBackend = {
      generate: async () => ({
        images: [{ url: "https://openai.com/test.png", mimeType: "image/png" }],
      }),
    };
    const mockGoogle: ImageBackend = {
      generate: async () => ({
        images: [{ base64: "gemini-b64", mimeType: "image/png" }],
      }),
    };

    const adapter = new AggregateInferenceAdapter({
      openaiImage: mockOpenAI,
      googleImage: mockGoogle,
    });

    // Test OpenAI routing
    const openaiTarget: InferenceTarget = {
      providerAccount: "work-openai",
      upstreamProvider: "openai",
      model: "dall-e-3",
      credential,
    };
    const boundOpenAI = await adapter.bind(openaiTarget);
    const oaiRes = await boundOpenAI.images!.generate({
      prompt: "OpenAI photo",
      operation: "generate",
    });
    expect(oaiRes.images[0].url).toBe("https://openai.com/test.png");

    // Test Google routing
    const googleTarget: InferenceTarget = {
      providerAccount: "work-google",
      upstreamProvider: "google",
      model: "gemini-3.1-flash-image",
      credential,
    };
    const boundGoogle = await adapter.bind(googleTarget);
    const gRes = await boundGoogle.images!.generate({
      prompt: "Google photo",
      operation: "generate",
    });
    expect(gRes.images[0].base64).toBe("gemini-b64");
  });
});
