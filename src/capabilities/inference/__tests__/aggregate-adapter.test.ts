import { describe, it, expect } from "vitest";
import { AggregateInferenceAdapter } from "../aggregate-adapter.js";
import type {
  InferenceTarget,
  LanguageBackend,
  ImageBackend,
} from "../../../foundations/contracts/backend-ports.js";
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

  it("strictly enforces catalog operation flags (rejects unsupported operations)", async () => {
    const mockOpenAI: ImageBackend = {
      generate: async () => ({
        images: [{ url: "https://openai.com/test.png", mimeType: "image/png" }],
      }),
    };

    const adapter = new AggregateInferenceAdapter({
      openaiImage: mockOpenAI,
    });

    const target: InferenceTarget = {
      providerAccount: "work-openai",
      upstreamProvider: "openai",
      model: "dall-e-3", // dall-e-3 supports generate, but NOT edit/variation
      credential,
    };

    const bound = await adapter.bind(target);
    expect(bound.images).toBeDefined();

    // Generate succeeds
    const genRes = await bound.images!.generate({
      prompt: "A dog",
      operation: "generate",
    });
    expect(genRes.images.length).toBe(1);

    // Edit fails with unsupported_capability BEFORE calling vendor
    try {
      await bound.images!.generate({
        prompt: "Edit dog",
        operation: "edit",
      });
      expect.fail("Should have thrown InferenceError");
    } catch (e: any) {
      expect(e).toBeInstanceOf(InferenceError);
      expect(e.code).toBe("unsupported_capability");
    }
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
