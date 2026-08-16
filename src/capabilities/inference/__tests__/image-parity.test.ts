import { describe, it, expect } from "vitest";
import { AggregateInferenceAdapter } from "../aggregate-adapter.js";
import { OpenAIImageRaw } from "../../../vendors/openai/openai-image-raw.js";
import { GoogleImageRaw } from "../../../vendors/google/google-image-raw.js";
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

describe("Image Parity across Backends (QS-P3.11)", () => {
  const credential = createMockCredential();

  it("produces standardized ImageResult across OpenAI and Google image backends", async () => {
    const mockOpenAIClient: any = {
      images: {
        generate: async () => ({
          created: 1700000000,
          data: [{ b64_json: "openai-base64-data", revised_prompt: "clean prompt" }],
        }),
      },
    };

    const mockGoogleClient: any = {
      models: {
        generateContent: async () => ({
          candidates: [
            {
              content: {
                parts: [
                  {
                    inlineData: {
                      mimeType: "image/png",
                      data: "google-base64-data",
                    },
                  },
                ],
              },
            },
          ],
        }),
      },
    };

    const adapter = new AggregateInferenceAdapter({
      openaiImage: new OpenAIImageRaw(mockOpenAIClient),
      googleImage: new GoogleImageRaw(mockGoogleClient),
    });

    // 1. OpenAI DALL-E 3
    const oaiTarget: InferenceTarget = {
      providerAccount: "openai-account",
      upstreamProvider: "openai",
      model: "dall-e-3",
      credential,
    };
    const boundOAI = await adapter.bind(oaiTarget);
    const oaiResult = await boundOAI.images!.generate({
      prompt: "A blue sky",
      operation: "generate",
      qualityPreset: "high",
    });

    expect(oaiResult.images.length).toBe(1);
    expect(oaiResult.images[0].base64).toBe("openai-base64-data");
    expect(oaiResult.images[0].mimeType).toBe("image/png");

    // 2. Google Gemini 3.1 Flash Image
    const googleTarget: InferenceTarget = {
      providerAccount: "google-account",
      upstreamProvider: "google",
      model: "gemini-3.1-flash-image",
      credential,
    };
    const boundGoogle = await adapter.bind(googleTarget);
    const googleResult = await boundGoogle.images!.generate({
      prompt: "A blue sky",
      operation: "generate",
    });

    expect(googleResult.images.length).toBe(1);
    expect(googleResult.images[0].base64).toBe("google-base64-data");
    expect(googleResult.images[0].mimeType).toBe("image/png");
  });
});
