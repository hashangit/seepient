import { describe, it, expect } from "vitest";
import { DiscoveryCache } from "../discovery-cache.js";
import { ModelCatalog } from "../model-catalog.js";
import type {
  DiscoverySource,
  ProviderAccountContext,
  DiscoveryResult,
} from "../../../foundations/contracts/backend-ports.js";
import type { ProviderEffectiveConfig } from "../../../foundations/schemas/provider-config.js";

function createMockAccountContext(name = "work-openai"): ProviderAccountContext {
  return {
    providerAccount: name,
    upstreamProvider: "openai",
    credential: {
      id: "cred-1",
      ref: { kind: "env", name: "OPENAI_API_KEY" },
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
    },
  };
}

describe("Failure-safe Discovery & ModelCatalog (QS-P4.4 & P4.4a)", () => {
  describe("DiscoveryCache P4.4a rules", () => {
    it("Rule 1: account save/refresh succeeds when discovery fails, recording lastRefreshError", async () => {
      const cache = new DiscoveryCache();
      const failingSource: DiscoverySource = {
        discover: async (): Promise<DiscoveryResult> => ({
          modelIds: [],
          error: "Endpoint timed out (504 Gateway Timeout)",
        }),
      };

      const record = await cache.refreshAccount(createMockAccountContext("work-openai"), failingSource);
      expect(record.account).toBe("work-openai");
      expect(record.modelIds).toEqual([]);
      expect(record.lastRefreshError).toBe("Endpoint timed out (504 Gateway Timeout)");
      expect(record.lastRefreshedAt).toBeNull();
    });

    it("Rule 2: cached models are retained after a subsequent refresh failure", async () => {
      const cache = new DiscoveryCache();

      // Step 1: Initial successful discovery
      const successSource: DiscoverySource = {
        discover: async () => ({ modelIds: ["gpt-4o", "gpt-4o-mini"] }),
      };
      const rec1 = await cache.refreshAccount(createMockAccountContext("work-openai"), successSource);
      expect(rec1.modelIds).toEqual(["gpt-4o", "gpt-4o-mini"]);
      expect(rec1.lastRefreshError).toBeUndefined();
      expect(rec1.lastRefreshedAt).toBeDefined();

      const origTimestamp = rec1.lastRefreshedAt;

      // Step 2: Subsequent discovery fails
      const failSource: DiscoverySource = {
        discover: async () => ({ modelIds: [], error: "429 Rate Limit" }),
      };
      const rec2 = await cache.refreshAccount(createMockAccountContext("work-openai"), failSource);

      // Prior model IDs retained!
      expect(rec2.modelIds).toEqual(["gpt-4o", "gpt-4o-mini"]);
      expect(rec2.lastRefreshError).toBe("429 Rate Limit");
      expect(rec2.lastRefreshedAt).toBe(origTimestamp);
    });

    it("Rule 3 & 4: surfaces lastRefreshedAt + lastRefreshError and supports manual refresh", async () => {
      const cache = new DiscoveryCache();
      const mockSource: DiscoverySource = {
        discover: async () => ({ modelIds: ["claude-3-7-sonnet"] }),
      };

      const res = await cache.refreshAccount(createMockAccountContext("anthropic-work"), mockSource);
      expect(res.lastRefreshedAt).toBeDefined();
      expect(res.lastRefreshError).toBeUndefined();
      expect(res.modelIds).toContain("claude-3-7-sonnet");
    });

    it("Rule 5: background scheduled refresh is asynchronous and non-blocking", async () => {
      const cache = new DiscoveryCache();
      let refreshInvoked = false;

      const asyncSource: DiscoverySource = {
        discover: async () => {
          refreshInvoked = true;
          return { modelIds: ["async-model-1"] };
        },
      };

      cache.scheduleBackgroundRefresh(createMockAccountContext("bg-account"), asyncSource);
      expect(refreshInvoked).toBe(false); // does not block caller synchronously

      // Wait a tick for setImmediate
      await new Promise((r) => setTimeout(r, 10));
      expect(refreshInvoked).toBe(true);
    });
  });

  describe("ModelCatalog", () => {
    it("projects reachableVia accounts for available models", async () => {
      const catalog = new ModelCatalog();

      const config: ProviderEffectiveConfig = {
        schemaVersion: 2,
        revision: 1,
        updatedAt: new Date().toISOString(),
        providers: {
          "openai-prod": {
            adapter: "pi-ai",
            upstreamProvider: "openai",
            credential: { kind: "env", name: "OPENAI_API_KEY" },
          },
          "openai-backup": {
            adapter: "pi-ai",
            upstreamProvider: "openai",
            credential: { kind: "env", name: "OPENAI_BACKUP_KEY" },
          },
          "google-primary": {
            adapter: "pi-ai",
            upstreamProvider: "google",
            credential: { kind: "env", name: "GEMINI_API_KEY" },
          },
        },
        modelAssignments: {},
        retryPolicy: {
          maxAttempts: 3,
          operationTimeoutMs: 60000,
          streamingIdleTimeoutMs: 30000,
          backoffBaseMs: 500,
          backoffMultiplier: 2,
          backoffJitter: 0.25,
          backoffCapMs: 30000,
          cooldownThreshold: 3,
          cooldownDurationMs: 60000,
        },
      };

      const available = await catalog.listAvailableModels(config);

      const gpt4o = available.find((m) => m.id === "gpt-4o");
      expect(gpt4o).toBeDefined();
      expect(gpt4o?.reachableVia).toEqual(["openai-prod", "openai-backup"]);

      const gemini = available.find((m) => m.id === "gemini-3.1-flash-image");
      expect(gemini).toBeDefined();
      expect(gemini?.reachableVia).toEqual(["google-primary"]);
    });
  });
});
