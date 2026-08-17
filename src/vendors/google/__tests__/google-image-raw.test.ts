import { describe, it, expect } from "vitest";
import { GoogleImageRaw } from "../google-image-raw.js";
import type { InferenceTarget } from "../../../foundations/contracts/backend-ports.js";
import type {
  CredentialHandle,
  CredentialLease,
} from "../../../foundations/contracts/credential-store.js";
import { InferenceError } from "../../../foundations/errors.js";

function createMockCredential(apiKey = "google-test-key", onRelease?: () => void): CredentialHandle {
  let activeLeases = 0;
  return {
    id: "cred-test",
    ref: { kind: "env", name: "TEST_KEY" },
    get activeLeaseCount() {
      return activeLeases;
    },
    async isResolvable() {
      return true;
    },
    acquireLease() {
      activeLeases++;
      const lease: CredentialLease = {
        leaseId: `lease-${activeLeases}`,
        isReleased: false,
        async secret() {
          return { kind: "api_key", value: apiKey };
        },
        async release() {
          (lease as any).isReleased = true;
          activeLeases = Math.max(0, activeLeases - 1);
          if (onRelease) onRelease();
        },
      };
      return lease;
    },
  };
}

describe("GoogleImageRaw backend (QS-P3.5)", () => {
  it("generates image via @google/genai and returns base64 image items", async () => {
    let released = false;
    const credential = createMockCredential("google-key", () => {
      released = true;
    });

    const mockAi: any = {
      models: {
        generateContent: async () => ({
          candidates: [
            {
              content: {
                parts: [
                  {
                    inlineData: {
                      mimeType: "image/png",
                      data: "fake-gemini-image-data",
                    },
                  },
                ],
              },
            },
          ],
        }),
      },
    };

    const backend = new GoogleImageRaw(mockAi);
    const target: InferenceTarget = {
      providerAccount: "google-work",
      upstreamProvider: "google",
      model: "gemini-3.1-flash-image",
      credential,
    };

    const result = await backend.generate(target, {
      prompt: "A futuristic city",
      operation: "generate",
    });

    expect(result.images.length).toBe(1);
    expect(result.images[0].base64).toBe("fake-gemini-image-data");
    expect(released).toBe(true);
    expect(credential.activeLeaseCount).toBe(0);
  });

  it("maps unsupported model error to unsupported_capability InferenceError", async () => {
    const credential = createMockCredential();

    const mockAi: any = {
      models: {
        generateContent: async () => {
          throw new Error("Operation edit is not supported on this model");
        },
      },
    };

    const backend = new GoogleImageRaw(mockAi);
    const target: InferenceTarget = {
      providerAccount: "google-work",
      upstreamProvider: "google",
      model: "gemini-2.5-flash-image",
      credential,
    };

    try {
      await backend.generate(target, {
        prompt: "Edit photo",
        operation: "edit",
      });
      expect.fail("Should have thrown");
    } catch (e: any) {
      expect(e).toBeInstanceOf(InferenceError);
      expect(e.code).toBe("unsupported_capability");
      expect(e.retryable).toBe(false);
    }
  });

  it("passes aspectRatio to imageConfig in Google GenAI options", async () => {
    const credential = createMockCredential();
    let passedParams: any;

    const mockAi: any = {
      models: {
        generateContent: async (params: any) => {
          passedParams = params;
          return {
            candidates: [
              {
                content: {
                  parts: [{ inlineData: { mimeType: "image/png", data: "gemini-16-9-b64" } }],
                },
              },
            ],
          };
        },
      },
    };

    const backend = new GoogleImageRaw(mockAi);
    const target: InferenceTarget = {
      providerAccount: "google-work",
      upstreamProvider: "google",
      model: "gemini-3.1-flash-image",
      credential,
    };

    await backend.generate(target, {
      prompt: "A panoramic mountain view",
      operation: "generate",
      aspectRatio: "16:9",
    });

    expect(passedParams.config?.imageConfig?.aspectRatio).toBe("16:9");
  });

  it("aborts in-flight request on timeout", async () => {
    const credential = createMockCredential();
    let receivedSignal: AbortSignal | undefined;

    const mockAi: any = {
      models: {
        generateContent: async (params: any) => {
          receivedSignal = params.config?.abortSignal;
          return new Promise<never>(() => {
            // Never resolves
          });
        },
      },
    };

    const backend = new GoogleImageRaw(mockAi);
    const target: InferenceTarget = {
      providerAccount: "google-work",
      upstreamProvider: "google",
      model: "gemini-3.1-flash-image",
      credential,
    };

    try {
      await backend.generate(
        target,
        { prompt: "Long request", operation: "generate" },
        { timeoutMs: 20 },
      );
      expect.fail("Should have timed out");
    } catch (e: any) {
      expect(e).toBeInstanceOf(InferenceError);
      expect(e.code).toBe("timeout");
      expect(receivedSignal?.aborted).toBe(true);
    }
  });
});
