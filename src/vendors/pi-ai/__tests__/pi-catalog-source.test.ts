import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PiCatalogSource } from "../pi-catalog-source.js";
import type { UpstreamModel, ThinkingLevel } from "../../../foundations/schemas/inference.js";

const VALID_THINKING_LEVELS: readonly ThinkingLevel[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

const FROZEN_CATALOG_FIXTURE: UpstreamModel[] = JSON.parse(
  readFileSync(resolve(__dirname, "./fixtures/frozen-catalog.json"), "utf-8"),
);

describe("T007: Frozen Catalog Fixture Exact-Value Assertions (QS-P2 / D5)", () => {
  it("verifies exact 2026 model attributes from frozen fixture", () => {
    // Anthropic
    const sonnet5 = FROZEN_CATALOG_FIXTURE.find((m) => m.id === "claude-sonnet-5" && m.upstreamProvider === "anthropic")!;
    expect(sonnet5).toBeDefined();
    expect(sonnet5.contextWindow).toBe(1000000);
    expect(sonnet5.pricing?.promptPerMillion).toBe(2);
    expect(sonnet5.pricing?.completionPerMillion).toBe(10);
    expect(sonnet5.pricing?.cachedPromptPerMillion).toBe(0.2);
    expect(sonnet5.pricing?.cacheWritePerMillion).toBe(2.5);

    const opus5 = FROZEN_CATALOG_FIXTURE.find((m) => m.id === "claude-opus-5" && m.upstreamProvider === "anthropic")!;
    expect(opus5).toBeDefined();
    expect(opus5.contextWindow).toBe(1000000);
    expect(opus5.pricing?.promptPerMillion).toBe(5);
    expect(opus5.pricing?.completionPerMillion).toBe(25);

    const haiku45 = FROZEN_CATALOG_FIXTURE.find((m) => m.id === "claude-haiku-4-5" && m.upstreamProvider === "anthropic")!;
    expect(haiku45).toBeDefined();
    expect(haiku45.contextWindow).toBe(200000);
    expect(haiku45.pricing?.promptPerMillion).toBe(1);

    // OpenAI
    const terra = FROZEN_CATALOG_FIXTURE.find((m) => m.id === "gpt-5.6-terra" && m.upstreamProvider === "openai")!;
    expect(terra).toBeDefined();
    expect(terra.contextWindow).toBe(272000);
    expect(terra.pricing?.promptPerMillion).toBe(2);
    expect(terra.pricing?.completionPerMillion).toBe(12);
    expect(terra.pricing?.cachedPromptPerMillion).toBe(0.2);

    const sol = FROZEN_CATALOG_FIXTURE.find((m) => m.id === "gpt-5.6-sol" && (m.upstreamProvider === "openai" || m.upstreamProvider === "opencode"))!;
    expect(sol).toBeDefined();
    expect(sol.pricing?.cachedPromptPerMillion).toBe(0.5);

    const luna = FROZEN_CATALOG_FIXTURE.find((m) => m.id === "gpt-5.6-luna" && (m.upstreamProvider === "openai" || m.upstreamProvider === "opencode"))!;
    expect(luna).toBeDefined();
    expect(luna.pricing?.cachedPromptPerMillion).toBe(0.02);

    // Google
    const gemini37 = FROZEN_CATALOG_FIXTURE.find((m) => m.id === "gemini-3.7-flash" && (m.upstreamProvider === "google" || m.upstreamProvider === "opencode"))!;
    expect(gemini37).toBeDefined();
    expect(gemini37.contextWindow).toBe(1048576);
    expect(gemini37.pricing?.promptPerMillion).toBe(0.75);
    expect(gemini37.pricing?.completionPerMillion).toBe(3.75);
    expect(gemini37.pricing?.cachedPromptPerMillion).toBe(0.075);

    const gemini31 = FROZEN_CATALOG_FIXTURE.find((m) => m.id === "gemini-3.1-pro-preview" && (m.upstreamProvider === "google" || m.upstreamProvider === "opencode"))!;
    expect(gemini31).toBeDefined();
    expect(gemini31.pricing?.cachedPromptPerMillion).toBe(0.2);

    // ZAI
    const glm53 = FROZEN_CATALOG_FIXTURE.find((m) => m.id === "glm-5.3" && m.upstreamProvider === "zai")!;
    expect(glm53).toBeDefined();
    expect(glm53.contextWindow).toBe(1000000);
    expect(glm53.pricing).toBeUndefined(); // zero-cost pruned

    // DeepSeek
    const dsPro = FROZEN_CATALOG_FIXTURE.find((m) => m.id === "deepseek-v4-pro" && m.upstreamProvider === "deepseek")!;
    expect(dsPro).toBeDefined();
    expect(dsPro.contextWindow).toBe(1000000);
    expect(dsPro.pricing?.promptPerMillion).toBe(0.435);
    expect(dsPro.pricing?.completionPerMillion).toBe(0.87);

    const dsFlash = FROZEN_CATALOG_FIXTURE.find((m) => m.id === "deepseek-v4-flash" && m.upstreamProvider === "deepseek")!;
    expect(dsFlash).toBeDefined();
    expect(dsFlash.pricing?.promptPerMillion).toBe(0.14);

    // xAI
    const grok46 = FROZEN_CATALOG_FIXTURE.find((m) => m.id === "grok-4.6" && m.upstreamProvider === "xai")!;
    expect(grok46).toBeDefined();
    expect(grok46.contextWindow).toBe(500000);
    expect(grok46.pricing?.promptPerMillion).toBe(2);
    expect(grok46.pricing?.completionPerMillion).toBe(6);

    const grok45 = FROZEN_CATALOG_FIXTURE.find((m) => m.id === "grok-4.5" && m.upstreamProvider === "xai")!;
    expect(grok45).toBeDefined();
    expect(grok45.pricing?.promptPerMillion).toBe(2);

    // Reasoning levels check across all fixture models
    for (const m of FROZEN_CATALOG_FIXTURE) {
      if (m.supportedReasoningLevels) {
        expect(m.supportedReasoningLevels).not.toContain("off");
        for (const level of m.supportedReasoningLevels) {
          expect(VALID_THINKING_LEVELS).toContain(level);
        }
      }
    }
  });
});

describe("T008: Live Structural Smoke Test (Drift-Tolerant)", () => {
  it("loads live installed pi-ai catalog and validates structural invariants", async () => {
    const source = new PiCatalogSource();
    const models = await source.list();

    expect(models.length).toBeGreaterThan(1000);

    // Assert key model families exist in installed package
    const hasOpenAI = models.some((m) => m.upstreamProvider === "openai" || m.upstreamProvider === "opencode");
    const hasAnthropic = models.some((m) => m.upstreamProvider === "anthropic");
    const hasGoogle = models.some((m) => m.upstreamProvider === "google" || m.upstreamProvider === "opencode");
    const hasZai = models.some((m) => m.upstreamProvider === "zai" || m.upstreamProvider === "opencode-go");

    expect(hasOpenAI).toBe(true);
    expect(hasAnthropic).toBe(true);
    expect(hasGoogle).toBe(true);
    expect(hasZai).toBe(true);

    // Assert key flagship 2026 model IDs are present
    const keyModels = ["claude-sonnet-5", "claude-opus-5", "gemini-3.7-flash", "glm-5.3"];
    for (const id of keyModels) {
      expect(models.some((m) => m.id === id || m.id.includes(id))).toBe(true);
    }

    // Structural validation for reasoning levels and never-0 pricing contract
    for (const m of models) {
      if (m.supportedReasoningLevels) {
        expect(m.supportedReasoningLevels).not.toContain("off");
        for (const level of m.supportedReasoningLevels) {
          expect(VALID_THINKING_LEVELS).toContain(level);
        }
      }
      if (m.pricing) {
        // If pricing is defined, prompt and completion must be positive numbers
        if (m.pricing.promptPerMillion !== undefined) {
          expect(m.pricing.promptPerMillion).toBeGreaterThan(0);
        }
        if (m.pricing.completionPerMillion !== undefined) {
          expect(m.pricing.completionPerMillion).toBeGreaterThan(0);
        }
      }
    }
  });
});

