import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { UpstreamModel } from "../../../foundations/schemas/inference.js";
import {
  resolveDefaultModelForProvider,
  normalizeProviderName,
  getModelMeta,
  extractGeneration,
  compareGenerations,
  scoreModelForTier,
} from "../../../foundations/models-catalog.js";
import { getSyncBuiltinCatalog } from "../model-catalog.js";
import { resolveInvocationPlan, type TurnSnapshot } from "../assignment-resolver.js";
import { MemoryCredentialStore } from "../credentials/memory-credential-store.js";
import { InferenceError } from "../../../foundations/errors.js";

// Load frozen catalog fixture
const FROZEN_CATALOG_FIXTURE: UpstreamModel[] = JSON.parse(
  readFileSync(resolve(__dirname, "../../../vendors/pi-ai/__tests__/fixtures/frozen-catalog.json"), "utf-8"),
);

describe("T001: Natural-version generation extractor", () => {
  it("extracts numeric generation tuples accurately", () => {
    expect(extractGeneration("gpt-5.6-terra")).toEqual([5, 6]);
    expect(extractGeneration("claude-opus-4-8")).toEqual([4, 8]);
    expect(extractGeneration("deepseek-v4-pro")).toEqual([4]);
    expect(extractGeneration("o3-pro")).toEqual([3]);
    expect(extractGeneration("glm-5.3")).toEqual([5, 3]);
    expect(extractGeneration("claude-sonnet-5")).toEqual([5]);
    expect(extractGeneration("custom-unversioned-model")).toEqual([0]);
    expect(extractGeneration("deep-research-max-preview-04-2026")).toEqual([0]);
  });

  it("compares generations numerically (5.10 > 5.6)", () => {
    expect(compareGenerations([5, 10], [5, 6])).toBeGreaterThan(0);
    expect(compareGenerations([5, 6], [5, 5])).toBeGreaterThan(0);
    expect(compareGenerations([5, 6], [4, 8])).toBeGreaterThan(0);
    expect(compareGenerations([4, 8], [4])).toBeGreaterThan(0);
    expect(compareGenerations([3], [3])).toBe(0);
    expect(compareGenerations([0], [1])).toBeLessThan(0);
  });
});

describe("T002 & T004: Dynamic Tier Model Scoring & QS-P3 Matrix", () => {
  it("scores models accurately for each purpose tier", () => {
    const sonnet5 = FROZEN_CATALOG_FIXTURE.find((m) => m.id === "claude-sonnet-5")!;
    const opus5 = FROZEN_CATALOG_FIXTURE.find((m) => m.id === "claude-opus-5")!;
    const haiku45 = FROZEN_CATALOG_FIXTURE.find((m) => m.id === "claude-haiku-4-5")!;

    // Standard tier scoring
    expect(scoreModelForTier(sonnet5, "standard")).toBe(100);
    expect(scoreModelForTier(opus5, "standard")).toBe(60);

    // Complex tier scoring
    expect(scoreModelForTier(opus5, "complex")).toBe(100);
    expect(scoreModelForTier(sonnet5, "complex")).toBe(70);

    // Efficient tier scoring
    expect(scoreModelForTier(haiku45, "efficient")).toBe(100);
  });

  it("resolves the entire QS-P3 matrix deterministically from frozen fixture", () => {
    // Anthropic
    expect(resolveDefaultModelForProvider(FROZEN_CATALOG_FIXTURE, "anthropic", "standard")).toBe("claude-sonnet-5");
    expect(resolveDefaultModelForProvider(FROZEN_CATALOG_FIXTURE, "anthropic", "complex")).toBe("claude-opus-5");
    expect(resolveDefaultModelForProvider(FROZEN_CATALOG_FIXTURE, "anthropic", "efficient")).toBe("claude-haiku-4-5");

    // OpenAI
    expect(resolveDefaultModelForProvider(FROZEN_CATALOG_FIXTURE, "openai", "standard")).toBe("gpt-5.6-terra");
    expect(resolveDefaultModelForProvider(FROZEN_CATALOG_FIXTURE, "openai", "complex")).toBe("gpt-5.6-sol");
    expect(resolveDefaultModelForProvider(FROZEN_CATALOG_FIXTURE, "openai", "efficient")).toBe("gpt-5.6-luna");

    // Google
    expect(resolveDefaultModelForProvider(FROZEN_CATALOG_FIXTURE, "google", "efficient")).toBe("gemini-3.7-flash");
    expect(resolveDefaultModelForProvider(FROZEN_CATALOG_FIXTURE, "google", "complex")).toBe("gemini-3.1-pro-preview");

    // ZAI / GLM (aliased)
    expect(resolveDefaultModelForProvider(FROZEN_CATALOG_FIXTURE, "zai", "standard")).toBe("glm-5.3");
    expect(resolveDefaultModelForProvider(FROZEN_CATALOG_FIXTURE, "glm", "standard")).toBe("glm-5.3");

    // DeepSeek
    expect(resolveDefaultModelForProvider(FROZEN_CATALOG_FIXTURE, "deepseek", "standard")).toBe("deepseek-v4-pro");
    expect(resolveDefaultModelForProvider(FROZEN_CATALOG_FIXTURE, "deepseek", "efficient")).toBe("deepseek-v4-flash");

    // xAI
    expect(resolveDefaultModelForProvider(FROZEN_CATALOG_FIXTURE, "xai", "standard")).toBe("grok-4.6");
  });

  it("tie-break sanity: generation-first prevents older large-context models from winning", () => {
    // In complex tier: gpt-5.6-sol vs gpt-5.5-pro (1.05M ctx) -> gpt-5.6-sol wins due to generation 5.6 > 5.5
    expect(resolveDefaultModelForProvider(FROZEN_CATALOG_FIXTURE, "openai", "complex")).toBe("gpt-5.6-sol");

    // In standard tier: gpt-5.6-terra vs gpt-5.3-codex -> gpt-5.6-terra wins due to generation 5.6 > 5.3
    expect(resolveDefaultModelForProvider(FROZEN_CATALOG_FIXTURE, "openai", "standard")).toBe("gpt-5.6-terra");
  });

  it("throws UNCONFIGURED_PROVIDER when provider has no candidate models", () => {
    expect(() => {
      resolveDefaultModelForProvider(FROZEN_CATALOG_FIXTURE, "nonexistent-provider", "standard");
    }).toThrowError(/No candidate models found in catalog for provider/);
  });
});

describe("WS2 Regression & Baseline Checks", () => {
  it("fails closed in assignment-resolver for unknown models and vision capability mismatch", async () => {
    const creds = new MemoryCredentialStore();
    await creds.put("test_key", { kind: "api_key", keyValue: "sk-test" });

    const assignments = {
      text: { standard: { providerAccount: "openai", model: "unknown-gpt-99" } },
      vision: { standard: { providerAccount: "zai", model: "glm-4.7" } },
    };

    const snapshot: TurnSnapshot = {
      revision: 1,
      createdAt: new Date().toISOString(),
      catalog: FROZEN_CATALOG_FIXTURE,
      config: {
        schemaVersion: 2,
        revision: 1,
        updatedAt: new Date().toISOString(),
        providers: {
          openai: { adapter: "pi-ai", upstreamProvider: "openai", credential: { kind: "env", name: "OPENAI_API_KEY" } },
          zai: { adapter: "pi-ai", upstreamProvider: "zai", credential: { kind: "env", name: "GLM_API_KEY" } },
        },
        modelAssignments: assignments as any,
        retryPolicy: {
          maxAttempts: 1,
          operationTimeoutMs: 60000,
          streamingIdleTimeoutMs: 30000,
          backoffBaseMs: 100,
          backoffMultiplier: 1.5,
          backoffJitter: 0.1,
          backoffCapMs: 1000,
          cooldownThreshold: 3,
          cooldownDurationMs: 60000,
        },
      },
      assignments: assignments as any,
    };

    // Unknown model in non-override config path -> rejected with unknown_model and suggestions
    await expect(
      resolveInvocationPlan(snapshot, creds, "text", "standard"),
    ).rejects.toThrowError(/Unknown model "unknown-gpt-99"/);

    // Vision purpose with vision: false model -> rejected with unsupported_capability
    const visionMismatchSnapshot: TurnSnapshot = {
      ...snapshot,
      catalog: [
        {
          id: "text-only-model",
          upstreamProvider: "openai",
          displayName: "Text Only Model",
          contextWindow: 128000,
          capabilities: { toolUse: true, streaming: true, vision: false },
          provenance: "pi-catalog",
        },
      ],
      assignments: {
        vision: { standard: { providerAccount: "openai", model: "text-only-model" } },
      } as any,
    };

    await expect(
      resolveInvocationPlan(visionMismatchSnapshot, creds, "vision", "standard"),
    ).rejects.toThrowError(/does not support vision/);
  });

  it("synchronous getSyncBuiltinCatalog and getModelMeta return community catalog data", () => {
    const syncCatalog = getSyncBuiltinCatalog();
    expect(syncCatalog.length).toBeGreaterThan(1000);

    const terraMeta = getModelMeta("gpt-5.6-terra");
    expect(terraMeta).toBeDefined();
    expect(terraMeta?.name).toBeDefined();
  });
});

