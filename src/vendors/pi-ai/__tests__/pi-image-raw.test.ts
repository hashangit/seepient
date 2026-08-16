import { describe, it, expect } from "vitest";
import { PiImageRaw } from "../pi-image-raw.js";
import type { InferenceTarget } from "../../../foundations/contracts/backend-ports.js";
import type { CredentialHandle } from "../../../foundations/contracts/credential-store.js";
import { InferenceError } from "../../../foundations/errors.js";

function createMockCredential(): CredentialHandle {
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
          return { kind: "api_key", value: "sk-pi" };
        },
        async release() {},
      };
    },
  };
}

describe("PiImageRaw backend (QS-P3.4)", () => {
  const credential = createMockCredential();

  it("calls generateImages and returns standardized ImageResult", async () => {
    const mockImageModels = {
      getModel: () => ({ id: "flux-schnell", provider: "openrouter" }),
      generateImages: async () => ({
        api: "openrouter-images",
        provider: "openrouter",
        model: "flux-schnell",
        output: [
          { type: "image", data: "base64-flux-image", mimeType: "image/png" },
        ],
        stopReason: "stop",
        timestamp: Date.now(),
      }),
    };

    const backend = new PiImageRaw(mockImageModels);
    const target: InferenceTarget = {
      providerAccount: "openrouter-acc",
      upstreamProvider: "openrouter",
      model: "flux-schnell",
      credential,
    };

    const result = await backend.generate(target, {
      prompt: "A sunset over mountains",
      operation: "generate",
    });

    expect(result.images.length).toBe(1);
    expect(result.images[0].base64).toBe("base64-flux-image");
    expect(result.images[0].mimeType).toBe("image/png");
  });

  it("rejects non-generate operations with unsupported_capability", async () => {
    const backend = new PiImageRaw();
    const target: InferenceTarget = {
      providerAccount: "openrouter-acc",
      upstreamProvider: "openrouter",
      model: "flux-schnell",
      credential,
    };

    try {
      await backend.generate(target, {
        prompt: "Edit photo",
        operation: "edit",
      });
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err).toBeInstanceOf(InferenceError);
      expect(err.code).toBe("unsupported_capability");
    }
  });
});
