import { describe, it, expect, vi } from "vitest";
import { PiImageRaw } from "../pi-image-raw.js";
import type { InferenceTarget } from "../../../foundations/contracts/backend-ports.js";
import type { CredentialHandle } from "../../../foundations/contracts/credential-store.js";
import { InferenceError } from "../../../foundations/errors.js";

function createMockCredential(secret: any = { kind: "api_key", value: "sk-pi" }): CredentialHandle {
  return {
    id: "cred-pi",
    ref: { kind: "env", name: "TEST_KEY" },
    activeLeaseCount: 0,
    async isResolvable() {
      return true;
    },
    acquireLease() {
      return {
        leaseId: "lease-pi",
        isReleased: false,
        async secret() {
          return secret;
        },
        async release() {},
      };
    },
  };
}

function makeTarget(overrides: Partial<InferenceTarget> = {}): InferenceTarget {
  return {
    providerAccount: "openrouter-acc",
    upstreamProvider: "openrouter",
    model: "flux-schnell",
    credential: createMockCredential(),
    ...overrides,
  } as InferenceTarget;
}

function makeMockModels(imageModel?: any) {
  // Pass null explicitly for a catalog that has no such image model.
  const resolved = imageModel === undefined
    ? { id: "flux-schnell", provider: "openrouter", type: "image" }
    : imageModel;
  const generateImages = vi.fn(async (_model: any, _context: any, _options: any) => ({
    api: "openrouter-images",
    provider: "openrouter",
    model: "flux-schnell",
    output: [
      { type: "image", data: "base64-flux-image", mimeType: "image/png" },
    ],
    stopReason: "stop",
    timestamp: Date.now(),
  }));
  const getModelOfType = vi.fn((kind: string, _provider: string, id: string) =>
    kind === "image" && resolved ? { ...resolved, id } : undefined,
  );
  return { models: { getModelOfType, generateImages }, getModelOfType, generateImages };
}

describe("PiImageRaw backend (QS-P3.4; 026 port to pi-ai 1.0 model-kind lookup)", () => {
  it("calls generateImages and returns standardized ImageResult", async () => {
    const { models, getModelOfType, generateImages } = makeMockModels();
    const backend = new PiImageRaw(models);
    const result = await backend.generate(makeTarget(), {
      prompt: "A sunset over mountains",
      operation: "generate",
    });

    // 026: the lookup must be kind-filtered — plain getModel can return the
    // chat operation of a colliding id.
    expect(getModelOfType).toHaveBeenCalledWith("image", "openrouter", "flux-schnell");
    expect(generateImages).toHaveBeenCalledTimes(1);
    expect(generateImages.mock.calls[0][1]).toEqual({
      input: [{ type: "text", text: "A sunset over mountains" }],
    });
    const callOpts = generateImages.mock.calls[0][2];
    expect(callOpts.apiKey).toBe("sk-pi");
    expect(result.images.length).toBe(1);
    expect(result.images[0].base64).toBe("base64-flux-image");
    expect(result.images[0].mimeType).toBe("image/png");
  });

  it("overrides the model baseUrl from the target when present", async () => {
    const { models, generateImages } = makeMockModels();
    const backend = new PiImageRaw(models);
    await backend.generate(
      makeTarget({ baseUrl: "https://custom.endpoint.example.com/v1" }),
      { prompt: "test", operation: "generate" },
    );
    const sentModel = generateImages.mock.calls[0][0];
    expect(sentModel.baseUrl).toBe("https://custom.endpoint.example.com/v1");
  });

  it("rejects non-generate operations with unsupported_capability", async () => {
    const backend = new PiImageRaw(makeMockModels().models);
    try {
      await backend.generate(makeTarget(), {
        prompt: "Edit photo",
        operation: "edit",
      });
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err).toBeInstanceOf(InferenceError);
      expect(err.code).toBe("unsupported_capability");
    }
  });

  it("denies unknown image models with unsupported_capability (kind-filtered lookup misses)", async () => {
    const { models, generateImages } = makeMockModels(null);
    const backend = new PiImageRaw(models);
    try {
      await backend.generate(makeTarget({ model: "no-such-model" }), {
        prompt: "test",
        operation: "generate",
      });
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err).toBeInstanceOf(InferenceError);
      expect(err.code).toBe("unsupported_capability");
      expect(err.message).toContain("no-such-model");
    }
    expect(generateImages).not.toHaveBeenCalled();
  });

  it("maps stopReason:error results to typed InferenceError (pi-ai 1.0 returns failures, does not throw)", async () => {
    const { models, generateImages } = makeMockModels();
    generateImages.mockResolvedValueOnce({
      api: "openrouter-images",
      provider: "openrouter",
      model: "flux-schnell",
      output: [],
      stopReason: "error",
      errorMessage: "provider quota exhausted",
      timestamp: Date.now(),
    } as any);
    const backend = new PiImageRaw(models);
    try {
      await backend.generate(makeTarget(), { prompt: "test", operation: "generate" });
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err).toBeInstanceOf(InferenceError);
      expect(err.message).toContain("provider quota exhausted");
    }
  });

  it("maps stopReason:aborted results to the typed abort classification", async () => {
    const { models, generateImages } = makeMockModels();
    generateImages.mockResolvedValueOnce({
      api: "openrouter-images",
      provider: "openrouter",
      model: "flux-schnell",
      output: [],
      stopReason: "aborted",
      timestamp: Date.now(),
    });
    const backend = new PiImageRaw(models);
    try {
      await backend.generate(makeTarget(), { prompt: "test", operation: "generate" });
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err).toBeInstanceOf(InferenceError);
      expect(err.code).toBe("timeout");
    }
  });

  it("maps a kind:none credential to the explicit unused sentinel (env fallback must never arm)", async () => {
    const { models, generateImages } = makeMockModels();
    const backend = new PiImageRaw(models);
    await backend.generate(
      makeTarget({ credential: createMockCredential({ kind: "none" }) }),
      { prompt: "test", operation: "generate" },
    );
    expect(generateImages.mock.calls[0][2].apiKey).toBe("unused");
  });

  it("denies missing credentials with CREDENTIAL_REQUIRED before the vendored boundary", async () => {
    const { models, generateImages } = makeMockModels();
    const backend = new PiImageRaw(models);
    try {
      await backend.generate(
        makeTarget({ credential: createMockCredential({ kind: "api_key", value: "" }) }),
        { prompt: "test", operation: "generate" },
      );
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err).toBeInstanceOf(InferenceError);
      expect(err.code).toBe("auth");
      expect(err.message).toContain("CREDENTIAL_REQUIRED");
    }
    expect(generateImages).not.toHaveBeenCalled();
  });

  it("multi-tenant: denies a baseUrl outside the egress envelope before any provider call", async () => {
    const { models, generateImages } = makeMockModels();
    const backend = new PiImageRaw(models);
    try {
      await backend.generate(
        makeTarget({ baseUrl: "https://attacker.example.com/v1" }),
        { prompt: "test", operation: "generate" },
        {
          tenancyMode: "multi",
          capabilities: [
            { kind: "network-destination", scheme: "https", host: "images.example.com", port: 443 },
          ],
        } as any,
      );
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err).toBeInstanceOf(InferenceError);
    }
    expect(generateImages).not.toHaveBeenCalled();
  });

  it("multi-tenant: allows a baseUrl inside the egress envelope and passes it through", async () => {
    const { models, generateImages } = makeMockModels();
    const backend = new PiImageRaw(models);
    await backend.generate(
      makeTarget({ baseUrl: "https://images.example.com/v1" }),
      { prompt: "test", operation: "generate" },
      {
        tenancyMode: "multi",
        capabilities: [
          { kind: "network-destination", scheme: "https", host: "images.example.com", port: 443 },
        ],
      } as any,
    );
    expect(generateImages).toHaveBeenCalledTimes(1);
    expect(generateImages.mock.calls[0][0].baseUrl).toBe("https://images.example.com/v1");
  });
});
