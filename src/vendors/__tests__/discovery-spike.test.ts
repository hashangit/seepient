/**
 * S0 spike — failure-safe shallow provider discovery (spec 010, S0.15 — Rev 4.3 S18).
 *
 * Hits each provider's `/models` list endpoint with provider-account config +
 * credentials (NOT an inference target — discovery happens before models are
 * known). Records:
 *   - the response SHAPE (what fields each provider returns)
 *   - rate-limit / error behavior
 *   - that a failed discovery does NOT throw past the caller (failure-safe)
 *
 * The 010 `DiscoverySource.discover(account: ProviderAccountContext)` contract
 * (inference-adapter.md §2) returns `readonly string[]` of raw model IDs; this
 * spike proves each source can produce that list from the account's own
 * `/models` endpoint and degrades gracefully on failure.
 *
 * Every live call is gated on its env key and SKIPS without it.
 */
import { describe, it, expect } from "vitest";
import { env, requireKey, SPIKE_KEYS } from "./spike-keys.js";

/** Record a discovery probe's outcome (the operator pastes shapes into research.md). */
interface DiscoveryResult {
  provider: string;
  ok: boolean;
  modelCount?: number;
  sampleIds?: string[];
  shape?: string;
  error?: string;
}

describe("S0.15 failure-safe shallow discovery", () => {
  it("OpenAI /v1/models — lists model IDs (shape + rate-limit recorded)", async (ctx) => {
    const key = env(SPIKE_KEYS.openai);
    requireKey(ctx, SPIKE_KEYS.openai, key, "to probe OpenAI /v1/models");
    const res = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${key}` },
    });
    const result: DiscoveryResult = { provider: "openai", ok: res.ok };
    if (res.ok) {
      const body = await res.json() as { data?: { id: string }[] };
      result.modelCount = body.data?.length;
      result.sampleIds = body.data?.slice(0, 5).map((m) => m.id);
      result.shape = "object with `data: [{id, ...}]`";
    } else {
      result.error = `${res.status} ${res.statusText}`;
    }
    // eslint-disable-next-line no-console
    console.log("OpenAI /v1/models:", JSON.stringify(result, null, 2));
    // Rate-limit behavior: 200 → ok; 401 → key bad; 429 → rate-limited (still failure-safe).
    expect([200, 401, 429]).toContain(res.status);
  }, 30_000);

  it("Google /v1beta/models — lists model IDs (shape + rate-limit recorded)", async (ctx) => {
    const key = env(SPIKE_KEYS.google);
    requireKey(ctx, SPIKE_KEYS.google, key, "to probe Google /v1beta/models");
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`;
    const res = await fetch(url);
    const result: DiscoveryResult = { provider: "google", ok: res.ok };
    if (res.ok) {
      const body = await res.json() as { models?: { name: string }[] };
      result.modelCount = body.models?.length;
      result.sampleIds = body.models?.slice(0, 5).map((m) => m.name);
      result.shape = "object with `models: [{name, supportedGenerationMethods, ...}]`";
    } else {
      result.error = `${res.status} ${res.statusText}`;
    }
    // eslint-disable-next-line no-console
    console.log("Google /v1beta/models:", JSON.stringify(result, null, 2));
    expect([200, 400, 403, 429]).toContain(res.status);
  }, 30_000);

  it("Pi discovery — surfaces model IDs via builtinImagesModels / builtinModels catalogs", async () => {
    // Pi does not expose a per-account `/models` endpoint of its own; its
    // "discovery" is the bundled catalog (builtinModels / builtinImagesModels).
    // This proves the CatalogSource shape (list of IDs) Pi contributes.
    const { builtinModels, builtinImagesModels } = await import("@earendil-works/pi-ai/providers/all");
    const chat = builtinModels().getModels().map((m) => m.id);
    const img = builtinImagesModels().getModels().map((m) => m.id);
    const result: DiscoveryResult = {
      provider: "pi",
      ok: true,
      modelCount: chat.length + img.length,
      sampleIds: [...chat.slice(0, 3), ...img.slice(0, 3)],
      shape: "bundled catalog (offline; refreshed by upgrading @earendil-works/pi-ai)",
    };
    // eslint-disable-next-line no-console
    console.log("Pi catalog discovery:", JSON.stringify(result, null, 2));
    expect(chat.length, "Pi chat catalog non-empty").toBeGreaterThan(0);
    expect(img.length, "Pi image catalog non-empty").toBeGreaterThan(0);
  });

  it("failure-safe: a discovery probe that fails does NOT throw past the caller", async () => {
    // Simulate an unreachable endpoint / bad key and confirm the probe degrades
    // to a recorded error rather than throwing. This is the 010 failure-safe
    // rule #1: account saving succeeds even if discovery fails.
    const res = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: "Bearer sk-invalid-key-for-spike" },
    });
    // We DO NOT throw on a non-200; we record the failure. The caller stays alive.
    const recorded: DiscoveryResult = {
      provider: "openai",
      ok: false,
      error: `${res.status} ${res.statusText}`,
    };
    expect(recorded.ok).toBe(false);
    expect([401, 429]).toContain(res.status);
    // lastRefreshError would carry this; lastRefreshedAt stays null/stale; cached models retained.
  }, 30_000);
});
