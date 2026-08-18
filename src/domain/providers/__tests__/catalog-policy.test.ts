import { describe, it, expect } from "vitest";
import type { UpstreamModel } from "../../../foundations/schemas/inference.js";
import {
  resolveDefaultModelForProvider,
  normalizeProviderName,
  getModelMeta,
  DEFAULT_MODELS,
} from "../../../foundations/models-catalog.js";
import { getSyncBuiltinCatalog } from "../model-catalog.js";
import { migrateV1ToV2, resolveMigratedModel } from "../migration.js";
import { resolveInvocationPlan, type TurnSnapshot } from "../assignment-resolver.js";
import { MemoryCredentialStore } from "../credentials/memory-credential-store.js";
import { InferenceError } from "../../../foundations/errors.js";

// Frozen catalog fixture for deterministic testing
const FROZEN_CATALOG_FIXTURE: UpstreamModel[] = [
  {
    id: "gpt-5.6-terra",
    upstreamProvider: "openai",
    displayName: "GPT-5.6 Terra",
    contextWindow: 256000,
    capabilities: { toolUse: true, streaming: true, vision: true },
    supportedReasoningLevels: ["none", "low", "medium", "high"],
    pricing: { promptPerMillion: 2.5, completionPerMillion: 10, cachedPromptPerMillion: 0.25 },
    provenance: "pi-catalog",
  },
  {
    id: "gpt-5.6-luna",
    upstreamProvider: "openai",
    displayName: "GPT-5.6 Luna",
    contextWindow: 128000,
    capabilities: { toolUse: true, streaming: true, vision: true },
    pricing: { promptPerMillion: 0.15, completionPerMillion: 0.6 },
    provenance: "pi-catalog",
  },
  {
    id: "gpt-5.6-sol",
    upstreamProvider: "openai",
    displayName: "GPT-5.6 Sol",
    contextWindow: 256000,
    capabilities: { toolUse: true, streaming: true, vision: true },
    supportedReasoningLevels: ["none", "low", "medium", "high", "max"],
    pricing: { promptPerMillion: 5, completionPerMillion: 20 },
    provenance: "pi-catalog",
  },
  {
    id: "claude-sonnet-5",
    upstreamProvider: "anthropic",
    displayName: "Claude Sonnet 5",
    contextWindow: 500000,
    capabilities: { toolUse: true, streaming: true, vision: true },
    supportedReasoningLevels: ["none", "low", "medium", "high", "max"],
    pricing: { promptPerMillion: 3, completionPerMillion: 15, cachedPromptPerMillion: 0.3 },
    provenance: "pi-catalog",
  },
  {
    id: "claude-haiku-4-5",
    upstreamProvider: "anthropic",
    displayName: "Claude Haiku 4.5",
    contextWindow: 200000,
    capabilities: { toolUse: true, streaming: true, vision: true },
    pricing: { promptPerMillion: 0.8, completionPerMillion: 4 },
    provenance: "pi-catalog",
  },
  {
    id: "glm-5.3",
    upstreamProvider: "zai",
    displayName: "GLM-5.3",
    contextWindow: 256000,
    capabilities: { toolUse: true, streaming: true, vision: true },
    supportedReasoningLevels: ["none", "low", "medium", "high"],
    provenance: "pi-catalog",
  },
  {
    id: "glm-4.5-air",
    upstreamProvider: "zai",
    displayName: "GLM-4.5 Air",
    contextWindow: 128000,
    capabilities: { toolUse: true, streaming: true, vision: false },
    provenance: "pi-catalog",
  },
];

describe("WS2 (R-3..R-9): Catalog-Native Redesign & Policy Defaults", () => {
  it("resolves default models deterministically across providers and tiers from frozen fixture", () => {
    // OpenAI tiers
    expect(resolveDefaultModelForProvider(FROZEN_CATALOG_FIXTURE, "openai", "standard")).toBe("gpt-5.6-terra");
    expect(resolveDefaultModelForProvider(FROZEN_CATALOG_FIXTURE, "openai", "efficient")).toBe("gpt-5.6-luna");
    expect(resolveDefaultModelForProvider(FROZEN_CATALOG_FIXTURE, "openai", "complex")).toBe("gpt-5.6-sol");

    // Anthropic tiers
    expect(resolveDefaultModelForProvider(FROZEN_CATALOG_FIXTURE, "anthropic", "standard")).toBe("claude-sonnet-5");
    expect(resolveDefaultModelForProvider(FROZEN_CATALOG_FIXTURE, "anthropic", "efficient")).toBe("claude-haiku-4-5");

    // GLM (aliased to zai) tiers
    expect(resolveDefaultModelForProvider(FROZEN_CATALOG_FIXTURE, "glm", "standard")).toBe("glm-5.3");
    expect(resolveDefaultModelForProvider(FROZEN_CATALOG_FIXTURE, "glm", "efficient")).toBe("glm-4.5-air");
  });

  it("throws UNCONFIGURED_PROVIDER when provider has no candidate models", () => {
    expect(() => {
      resolveDefaultModelForProvider(FROZEN_CATALOG_FIXTURE, "nonexistent-provider", "standard");
    }).toThrowError(/No candidate models found in catalog for provider/);
  });

  it("migrates dynamically without static model map", () => {
    // Shorthand "sonnet" for GLM -> remapped to GLM default with note
    const glmRes = resolveMigratedModel("glm", "sonnet");
    expect(glmRes.model).toBe("glm-5.3");
    expect(glmRes.remapped).toBe(true);

    // Exact catalog model -> preserved as-is
    const exactRes = resolveMigratedModel("openai", "gpt-5.6-terra");
    expect(exactRes.model).toBe("gpt-5.6-terra");
    expect(exactRes.remapped).toBe(false);

    // Full v1 migration test
    const v1Config = {
      provider: "glm",
      model: "sonnet",
      apiKey: "glm-secret-key",
    } as any;

    const migrated = migrateV1ToV2(v1Config);
    expect(migrated.config.providers.glm).toBeDefined();
    expect(migrated.config.modelAssignments.text?.standard?.providerAccount).toBe("glm");
    expect(migrated.config.modelAssignments.text?.standard?.model).toBe("glm-5.3");
    expect(migrated.remapNotes?.glm).toContain("Remapped v1 model");
  });

  it("fails closed in assignment-resolver for unknown models and vision capability mismatch", async () => {
    const creds = new MemoryCredentialStore();
    await creds.put("test_key", { kind: "api_key", keyValue: "sk-test" });

    const assignments = {
      text: { standard: { providerAccount: "openai", model: "unknown-gpt-99" } },
      vision: { standard: { providerAccount: "zai", model: "glm-4.5-air" } },
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

    // Unknown model -> rejected with unknown_model and suggestions
    await expect(
      resolveInvocationPlan(snapshot, creds, "text", "standard"),
    ).rejects.toThrowError(/Unknown model "unknown-gpt-99"/);

    // Vision purpose with vision: false model -> rejected with unsupported_capability
    await expect(
      resolveInvocationPlan(snapshot, creds, "vision", "standard"),
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
