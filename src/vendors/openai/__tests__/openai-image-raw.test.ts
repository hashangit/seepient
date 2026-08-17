import { describe, it, expect } from "vitest";
import { OpenAIImageRaw } from "../openai-image-raw.js";
import type { InferenceTarget } from "../../../foundations/contracts/backend-ports.js";
import type {
  CredentialHandle,
  CredentialLease,
} from "../../../foundations/contracts/credential-store.js";
import { InferenceError } from "../../../foundations/errors.js";

function createMockCredential(apiKey = "sk-test", onRelease?: () => void): CredentialHandle {
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

describe("OpenAIImageRaw backend (QS-P3.6)", () => {
  it("generates image via OpenAI SDK and returns base64 image items", async () => {
    let released = false;
    const credential = createMockCredential("sk-test", () => {
      released = true;
    });

    const mockClient: any = {
      images: {
        generate: async () => ({
          created: 1700000000,
          data: [{ b64_json: "fake-base64-payload", revised_prompt: "clean prompt" }],
        }),
      },
    };

    const backend = new OpenAIImageRaw(mockClient);
    const target: InferenceTarget = {
      providerAccount: "openai-main",
      upstreamProvider: "openai",
      model: "dall-e-3",
      credential,
    };

    const result = await backend.generate(target, {
      prompt: "A modern desk",
      operation: "generate",
      qualityPreset: "high",
      aspectRatio: "16:9",
    });

    expect(result.images.length).toBe(1);
    expect(result.images[0].base64).toBe("fake-base64-payload");
    expect(result.images[0].revisedPrompt).toBe("clean prompt");
    expect(released).toBe(true);
    expect(credential.activeLeaseCount).toBe(0);
  });

  it("handles image variations with in-memory base64 image buffer", async () => {
    const credential = createMockCredential();
    let passedFile: any;

    const mockClient: any = {
      images: {
        createVariation: async (params: any) => {
          passedFile = params.image;
          return {
            created: 1700000000,
            data: [{ b64_json: "variation-b64-payload" }],
          };
        },
      },
    };

    const backend = new OpenAIImageRaw(mockClient);
    const target: InferenceTarget = {
      providerAccount: "openai-main",
      upstreamProvider: "openai",
      model: "dall-e-2",
      credential,
    };

    const result = await backend.generate(target, {
      prompt: "Variation prompt",
      operation: "variation",
      inputImage: {
        type: "image",
        mediaType: "image/png",
        data: Buffer.from("fake-png-content").toString("base64"),
      },
    });

    expect(result.images.length).toBe(1);
    expect(result.images[0].base64).toBe("variation-b64-payload");
    expect(passedFile).toBeDefined();
  });

  it("maps HTTP 429 to rate_limit InferenceError with retryable=true", async () => {
    const credential = createMockCredential();

    const err: any = new Error("Rate limit exceeded");
    err.status = 429;
    const mockClient: any = {
      images: {
        generate: async () => {
          throw err;
        },
      },
    };

    const backend = new OpenAIImageRaw(mockClient);
    const target: InferenceTarget = {
      providerAccount: "openai-main",
      upstreamProvider: "openai",
      model: "dall-e-3",
      credential,
    };

    try {
      await backend.generate(target, {
        prompt: "A modern desk",
        operation: "generate",
      });
      expect.fail("Should have thrown InferenceError");
    } catch (e: any) {
      expect(e).toBeInstanceOf(InferenceError);
      expect(e.code).toBe("rate_limit");
      expect(e.retryable).toBe(true);
    }
  });

  it("forwards cancellation signal to in-flight request", async () => {
    const credential = createMockCredential();
    const ac = new AbortController();

    const mockClient: any = {
      images: {
        generate: async (_params: any, opts: any) => {
          return new Promise<never>((_, reject) => {
            if (opts?.signal) {
              opts.signal.addEventListener("abort", () => {
                const err: any = new Error("Request aborted");
                err.name = "AbortError";
                reject(err);
              });
            }
          });
        },
      },
    };

    const backend = new OpenAIImageRaw(mockClient);
    const target: InferenceTarget = {
      providerAccount: "openai-main",
      upstreamProvider: "openai",
      model: "dall-e-3",
      credential,
    };

    const genPromise = backend.generate(
      target,
      { prompt: "Testing abort", operation: "generate" },
      { signal: ac.signal },
    );

    setTimeout(() => ac.abort(new Error("User cancelled mid-flight")), 10);

    try {
      await genPromise;
      expect.fail("Should have thrown");
    } catch (e: any) {
      expect(e).toBeInstanceOf(InferenceError);
      expect(e.code).toBe("timeout");
    }
  });

  it("enforces n=1 for DALL-E 3 even when request specifies higher count", async () => {
    const credential = createMockCredential();
    let passedParams: any;

    const mockClient: any = {
      images: {
        generate: async (params: any) => {
          passedParams = params;
          return { data: [{ b64_json: "dalle3-b64" }] };
        },
      },
    };

    const backend = new OpenAIImageRaw(mockClient);
    const target: InferenceTarget = {
      providerAccount: "openai-main",
      upstreamProvider: "openai",
      model: "dall-e-3",
      credential,
    };

    await backend.generate(target, {
      prompt: "A landscape",
      count: 4,
      qualityPreset: "high",
      aspectRatio: "16:9",
    });

    expect(passedParams.n).toBe(1);
    expect(passedParams.quality).toBe("hd");
    expect(passedParams.size).toBe("1792x1024");
    expect(passedParams.response_format).toBe("b64_json");
  });

  it("formats gpt-image-2 parameters without forcing response_format: b64_json", async () => {
    const credential = createMockCredential();
    let passedParams: any;

    const mockClient: any = {
      images: {
        generate: async (params: any) => {
          passedParams = params;
          return { data: [{ b64_json: "gpt-image-b64" }] };
        },
      },
    };

    const backend = new OpenAIImageRaw(mockClient);
    const target: InferenceTarget = {
      providerAccount: "openai-main",
      upstreamProvider: "openai",
      model: "gpt-image-2",
      credential,
    };

    await backend.generate(target, {
      prompt: "A futuristic city",
      count: 2,
      qualityPreset: "high",
      aspectRatio: "9:16",
    });

    expect(passedParams.n).toBe(2);
    expect(passedParams.quality).toBe("high");
    expect(passedParams.size).toBe("1024x1536");
    expect(passedParams.response_format).toBeUndefined();
  });
});
