import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { OpenAIImageRaw } from "../../../../vendors/openai/openai-image-raw.js";
import { GoogleImageRaw } from "../../../../vendors/google/google-image-raw.js";
import type { InferenceTarget } from "../../../../foundations/contracts/backend-ports.js";

describe("Image Inference Boundary Armed Journey (OpenAI & Google)", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.OPENAI_API_KEY = "sk-host-decoy-openai-key";
    process.env.GEMINI_API_KEY = "host-decoy-gemini-key";
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("OpenAIImageRaw", () => {
    it("fails closed with CREDENTIAL_REQUIRED when credentials are none/empty in multi mode", async () => {
      const raw = new OpenAIImageRaw();
      const target: InferenceTarget = {
        providerAccount: "tenant-account-1",
        upstreamProvider: "openai",
        model: "dall-e-3",
        credential: {
          id: "cred-none",
          ref: { kind: "none" } as any,
          activeLeaseCount: 0,
          async isResolvable() { return true; },
          acquireLease() {
            return {
              leaseId: "lease-none",
              isReleased: false,
              async secret() { return { kind: "none" } as any; },
              async release() {},
            } as any;
          },
        },
      };

      await expect(
        raw.generate(target, { prompt: "test image" }, { tenancyMode: "multi" }),
      ).rejects.toThrow(/CREDENTIAL_REQUIRED/);
    });

    it("fails closed with EGRESS_REQUIRED when custom baseUrl lacks network-destination capability in multi mode", async () => {
      const raw = new OpenAIImageRaw();
      const target: InferenceTarget = {
        providerAccount: "tenant-account-1",
        upstreamProvider: "openai",
        model: "dall-e-3",
        baseUrl: "https://attacker.example.com/v1",
        credential: {
          id: "cred-test",
          ref: { kind: "api_key" } as any,
          activeLeaseCount: 0,
          async isResolvable() { return true; },
          acquireLease() {
            return {
              leaseId: "lease-1",
              isReleased: false,
              async secret() { return { kind: "api_key", value: "sk-tenant-key" }; },
              async release() {},
            } as any;
          },
        },
      };

      await expect(
        raw.generate(
          target,
          { prompt: "test image" },
          { tenancyMode: "multi", capabilities: [] },
        ),
      ).rejects.toThrow(/EGRESS_REQUIRED/);
    });
  });

  describe("GoogleImageRaw", () => {
    it("fails closed with CREDENTIAL_REQUIRED when credentials are none/empty in multi mode", async () => {
      const raw = new GoogleImageRaw();
      const target: InferenceTarget = {
        providerAccount: "tenant-account-1",
        upstreamProvider: "google",
        model: "imagen-3.0-generate-002",
        credential: {
          id: "cred-none",
          ref: { kind: "none" } as any,
          activeLeaseCount: 0,
          async isResolvable() { return true; },
          acquireLease() {
            return {
              leaseId: "lease-none",
              isReleased: false,
              async secret() { return { kind: "none" } as any; },
              async release() {},
            } as any;
          },
        },
      };

      await expect(
        raw.generate(target, { prompt: "test image" }, { tenancyMode: "multi" }),
      ).rejects.toThrow(/CREDENTIAL_REQUIRED/);
    });

    it("fails closed with EGRESS_REQUIRED when custom baseUrl lacks network-destination capability in multi mode", async () => {
      const raw = new GoogleImageRaw();
      const target: InferenceTarget = {
        providerAccount: "tenant-account-1",
        upstreamProvider: "google",
        model: "imagen-3.0-generate-002",
        baseUrl: "https://attacker.example.com/v1",
        credential: {
          id: "cred-test",
          ref: { kind: "api_key" } as any,
          activeLeaseCount: 0,
          async isResolvable() { return true; },
          acquireLease() {
            return {
              leaseId: "lease-1",
              isReleased: false,
              async secret() { return { kind: "api_key", value: "gemini-tenant-key" }; },
              async release() {},
            } as any;
          },
        },
      };

      await expect(
        raw.generate(
          target,
          { prompt: "test image" },
          { tenancyMode: "multi", capabilities: [] },
        ),
      ).rejects.toThrow(/EGRESS_REQUIRED/);
    });

    it("allows custom baseUrl when matching network-destination capability is granted (P1-4)", async () => {
      const raw = new GoogleImageRaw();
      const target: InferenceTarget = {
        providerAccount: "tenant-account-1",
        upstreamProvider: "google",
        model: "imagen-3.0-generate-002",
        baseUrl: "https://allowed.example.com/v1",
        credential: {
          id: "cred-test",
          ref: { kind: "api_key" } as any,
          activeLeaseCount: 0,
          async isResolvable() { return true; },
          acquireLease() {
            return {
              leaseId: "lease-1",
              isReleased: false,
              async secret() { return { kind: "api_key", value: "gemini-tenant-key" }; },
              async release() {},
            } as any;
          },
        },
      };

      await expect(
        raw.generate(
          target,
          { prompt: "test image" },
          {
            tenancyMode: "multi",
            capabilities: [
              { kind: "network-destination", scheme: "https", host: "allowed.example.com" },
            ],
          },
        ),
      ).rejects.not.toThrow(/EGRESS_REQUIRED/);
    });
  });

  describe("VendorOperationHandler Capability Forwarding (P1-4)", () => {
    it("forwards envelope capabilities to vendorOperationHandler", async () => {
      const { EffectBroker } = await import("../../../../capabilities/execution/effect-broker.js");
      const { InMemoryArtifactStore } = await import("../../../../capabilities/execution/in-memory-artifact-store.js");
      const artifacts = new InMemoryArtifactStore();

      let receivedCaps: any[] | undefined;
      const broker = new EffectBroker({
        artifacts,
        network: {} as any,
        tenancyMode: "multi",
        vendorOperationHandler: async (_req, caps) => {
          receivedCaps = caps;
          return {
            requestId: _req.requestId,
            status: "succeeded",
            output: "test-art" as any,
          };
        },
      });

      const grantedCap = { kind: "network-destination" as const, scheme: "https", host: "api.example.com" };
      const envelope = {
        principalId: "test-principal",
        runId: "test-run",
        capabilities: [grantedCap],
      };
      const auth = {
        principalId: "test-principal",
        runId: "test-run",
        modelProviderClass: "openai",
      };

      const result = await (broker as any).executeVendorOperation(
        {
          kind: "vendor-operation",
          requestId: "req-1",
          connector: "media",
          operation: "generate_image",
          input: { prompt: "a cat" },
        },
        envelope,
        auth,
      );

      expect(result.status).toBe("succeeded");
      expect(receivedCaps).toEqual([grantedCap]);
    });
  });
});
