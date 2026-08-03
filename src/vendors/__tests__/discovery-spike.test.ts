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
 * Live probes (OpenAI/Google) are gated on their env keys and skip without them.
 * The failure-safe rule itself is proven with a mocked rejecting fetch (no key,
 * no network) so it runs in CI and asserts the contract directly.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
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

afterEach(() => {
  vi.unstubAllGlobals();
});

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

  it("failure-safe: discovery that fails does NOT throw past the caller (mocked, no key needed)", async () => {
    // Prove the failure-safe contract directly with a mocked rejecting fetch:
    // a DiscoverySource wraps the network call and MUST return a recorded
    // failure rather than propagating the rejection. This is 010 rule #1:
    // account saving succeeds even if discovery is unavailable.
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("ETIMEDOUT: discovery endpoint unreachable");
    }));

    // Minimal mirror of the DiscoverySource.discover() failure-safe wrapper.
    async function discoverSafe(): Promise<DiscoveryResult> {
      try {
        const res = await fetch("https://example.invalid/v1/models");
        return { provider: "openai", ok: res.ok };
      } catch (err) {
        // Failure is RECORDED, never thrown past the caller.
        return { provider: "openai", ok: false, error: String(err) };
      }
    }

    const recorded = await discoverSafe();
    expect(recorded.ok, "failure recorded, not thrown").toBe(false);
    expect(recorded.error, "error detail captured").toMatch(/ETIMEDOUT/);
    // lastRefreshError would carry this; lastRefreshedAt stays null/stale; cached models retained.
  });
});
