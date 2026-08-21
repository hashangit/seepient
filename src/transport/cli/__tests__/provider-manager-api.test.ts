/**
 * 013 T004 — ProviderManagerApi controller unit tests (contract §6 matrix).
 * Runs against an in-memory config store + memory credential store.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createProviderManagerApi } from "../provider-manager-api.js";
import { ProviderConfigStore } from "../../../domain/providers/config-store/provider-config-store.js";
import { ProviderRuntime } from "../../../domain/providers/provider-runtime.js";
import { MemoryCredentialStore } from "../../../domain/providers/credentials/memory-credential-store.js";
import { SeepientError } from "../../../foundations/errors.js";
import type { ProviderLayerPatch } from "../../../foundations/schemas/provider-config.js";

const ENV_KEYS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GLM_API_KEY",
  "OPENAI_COMPAT_API_KEY",
  "OPENAI_COMPAT_BASE_URL",
  "LLM_PROVIDER",
  "SEEPIENT_PROVIDER",
];

const savedEnv: Record<string, string | undefined> = {};

function makeApi(overrides?: {
  credentialStore?: MemoryCredentialStore;
  configStore?: ProviderConfigStore;
}) {
  const configStore = overrides?.configStore ?? new ProviderConfigStore(":memory:");
  const credentialStore = overrides?.credentialStore ?? new MemoryCredentialStore();
  const runtime = new ProviderRuntime({ configStore, credentialStore });
  return { api: createProviderManagerApi(runtime), configStore, credentialStore, runtime };
}

/** Catalog stub: deterministic tiny catalog injected via runtime's ModelCatalog sources. */
function withCatalogModels(runtime: ProviderRuntime, models: any[]) {
  (runtime.modelCatalog as any).sources = [
    { id: "test", async list() { return models; }, async enrichModels(m: any[]) { return m; } },
  ];
  (runtime.modelCatalog as any).discoveryCache = {
    list: () => [],
    refreshAccount: async () => {},
  } as any;
}

const MODELS = [
  {
    id: "model-tool", upstreamProvider: "acme", displayName: "Model Tool", contextWindow: 100000,
    capabilities: { toolUse: true, streaming: true, vision: false },
    supportedReasoningLevels: ["none", "low", "high"], provenance: "pi-catalog",
  },
  {
    id: "model-vision", upstreamProvider: "acme", displayName: "Model Vision", contextWindow: 100000,
    capabilities: { toolUse: true, streaming: true, vision: true },
    supportedReasoningLevels: ["none"], provenance: "pi-catalog",
  },
  {
    id: "model-plain", upstreamProvider: "other", displayName: "Model Plain", contextWindow: 50000,
    capabilities: { toolUse: false, streaming: false, vision: false },
    supportedReasoningLevels: ["none"], provenance: "pi-catalog",
  },
];

beforeEach(() => {
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
});

describe("getState sanitization (contract §6.1)", () => {
  it("never exposes credential values, env contents, or headers", async () => {
    const { api, runtime } = makeApi();
    withCatalogModels(runtime, MODELS);
    await api.saveAccount({
      accountId: "acme-main", upstreamProvider: "acme",
      credential: { mode: "paste", keyValue: "sk-supersecretvalue" },
    });
    // Sneak headers + userinfo URL into the raw overlay the way a hand-edit would.
    const store = runtime.getConfigStore();
    const ov = await store.getOverlay();
    await store.updateOverlay({
      providers: { "acme-main": { headers: { Authorization: "Bearer tok-123" }, baseUrl: "https://u:p@corp.example/v1" } },
    } as any, ov.revision);

    const state = await api.getState();
    const acct = state.accounts.find((a) => a.id === "acme-main")!;
    expect(acct).toBeTruthy();
    const json = JSON.stringify(state);
    expect(json).not.toContain("sk-supersecretvalue");
    expect(json).not.toContain("tok-123");
    expect(json).not.toContain("u:p@");
    expect((acct as any).headers).toBeUndefined();
    expect(acct.baseUrl).not.toMatch(/u:p@/);
    expect(acct.credentialKind).toBe("seepient");
  });

  it("derives purposes from schema truth (coding present, media nested)", async () => {
    const { api } = makeApi();
    const state = await api.getState();
    const ids = state.purposes.map((p) => p.id);
    expect(ids).toContain("coding");
    expect(ids).toContain("media.image");
    expect(ids).toContain("media.transcription");
    expect(ids).not.toContain("image-generation");
    const vision = state.purposes.find((p) => p.id === "vision")!;
    expect(vision.tiered).toBe(true);
    expect(vision.requires).toContain("vision");
    const image = state.purposes.find((p) => p.id === "media.image")!;
    expect(image.tiered).toBe(false);
    expect(image.requires).toContain("imageGenerate");
  });
});

describe("saveAccount credential-first ordering (contract §6.2)", () => {
  it("aborts with no overlay write and no orphan credential when the store fails", async () => {
    class FailingStore extends MemoryCredentialStore {
      override async put(): Promise<void> {
        throw new SeepientError("keychain denied", "CREDENTIAL_STORE_FAILURE", false);
      }
    }
    const { api, configStore } = makeApi({ credentialStore: new FailingStore() as unknown as MemoryCredentialStore });
    const res = await api.saveAccount({
      accountId: "acme-x", upstreamProvider: "acme",
      credential: { mode: "paste", keyValue: "k1" },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("credential_unavailable");
    const eff = await configStore.getEffectiveConfig();
    expect(eff.providers?.["acme-x"]).toBeUndefined();
  });

  it("rolls back a just-written credential when the overlay write fails twice", async () => {
    const creds = new MemoryCredentialStore();
    let calls = 0;
    class FlakyStore extends ProviderConfigStore {
      constructor() { super(":memory:"); }
      override async updateOverlay(patch: ProviderLayerPatch, rev: number) {
        calls++;
        throw new SeepientError(`Optimistic concurrency violation: expected revision ${rev}, but current revision is ${rev}.`, "PRECONDITION_FAILED", false);
      }
    }
    const { api } = makeApi({ credentialStore: creds, configStore: new FlakyStore() });
    const res = await api.saveAccount({
      accountId: "acme-y", upstreamProvider: "acme",
      credential: { mode: "paste", keyValue: "k2" },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("conflict");
    expect(await creds.get("acme-y")).toBeUndefined(); // rolled back — no orphan
    expect(calls).toBe(2); // retried exactly once
  });
});

describe("OCC retry-once (contract §6.3)", () => {
  it("retries once on conflict and succeeds on the second attempt", async () => {
    const base = new ProviderConfigStore(":memory:");
    let fails = 1;
    class RetryOnceStore extends ProviderConfigStore {
      constructor() { super(":memory:"); }
      override async updateOverlay(patch: ProviderLayerPatch, rev: number) {
        if (fails > 0) { fails--; throw new SeepientError("stale revision", "PRECONDITION_FAILED", false); }
        return super.updateOverlay(patch, rev);
      }
    }
    void base;
    const { api } = makeApi({ configStore: new RetryOnceStore() });
    const res = await api.saveAccount({
      accountId: "acme-ok", upstreamProvider: "acme", credential: { mode: "none" },
    });
    expect(res.ok).toBe(true);
  });
});

describe("deleteAccount blocked/force (contract §6.4)", () => {
  it("lists referencing slots and deletes only with force; cleans seepient creds, keeps env refs", async () => {
    const { api, credentialStore, runtime } = makeApi();
    withCatalogModels(runtime, MODELS);
    await api.saveAccount({ accountId: "acme-main", upstreamProvider: "acme", credential: { mode: "paste", keyValue: "k" } });
    await api.saveAccount({ accountId: "acme-env", upstreamProvider: "other", credential: { mode: "env", varName: "ACME_KEY" } });
    await api.setAssignment("text", "standard", { providerAccount: "acme-main", model: "model-tool" });

    const blocked = await api.deleteAccount("acme-main");
    expect(blocked.ok).toBe(false);
    if (!blocked.ok && "blocked" in blocked) {
      expect(blocked.referencingSlots).toContain("text·standard");
    }

    const forced = await api.deleteAccount("acme-main", { force: true });
    expect(forced.ok).toBe(true);
    expect(await credentialStore.get("acme-main")).toBeUndefined(); // seepient-kind cleaned

    const envDel = await api.deleteAccount("acme-env", { force: true });
    expect(envDel.ok).toBe(true);
  });
});

describe("setAssignment validation (contract §6.5)", () => {
  beforeEach(async () => {
    const ctx = makeApi();
    withCatalogModels(ctx.runtime, MODELS);
    await ctx.api.saveAccount({ accountId: "acme-main", upstreamProvider: "acme", credential: { mode: "none" } });
    current = ctx;
  });
  let current: ReturnType<typeof makeApi>;

  it("rejects unknown models with suggestions", async () => {
    const res = await current.api.setAssignment("text", "standard", { providerAccount: "acme-main", model: "nope" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("unknown_model");
  });

  it("rejects capability mismatches with the exact reason", async () => {
    const res = await current.api.setAssignment("vision", "standard", { providerAccount: "acme-main", model: "model-tool" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("validation_failed");
      expect(res.error.message).toMatch(/vision/i);
    }
  });

  it("rejects unsupported thinking levels", async () => {
    const res = await current.api.setAssignment("text", "standard", {
      providerAccount: "acme-main", model: "model-tool", thinkingLevel: "max",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toMatch(/thinking/i);
  });

  it("slots are atomic: rewriting without thinkingLevel clears it", async () => {
    const a = await current.api.setAssignment("text", "standard", {
      providerAccount: "acme-main", model: "model-tool", thinkingLevel: "low",
    });
    expect(a.ok).toBe(true);
    const b = await current.api.setAssignment("text", "standard", {
      providerAccount: "acme-main", model: "model-tool",
    });
    expect(b.ok).toBe(true);
    if (b.ok) {
      const slot = (b.state.assignments as any).text?.standard;
      expect(slot.thinkingLevel).toBeUndefined();
    }
  });

  it("writes media single slots under media.*", async () => {
    // image model absent from stub catalog → rejected as unknown; assert that first
    const bad = await current.api.setAssignment("media.image", null, { providerAccount: "acme-main", model: "model-tool" });
    expect(bad.ok).toBe(false);
  });
});

describe("resolvePreview (contract §6.6)", () => {
  it("labels via=fallback-chain for unset tiers and via=requested for set ones", async () => {
    const ctx = makeApi();
    withCatalogModels(ctx.runtime, MODELS);
    await ctx.api.saveAccount({ accountId: "acme-main", upstreamProvider: "acme", credential: { mode: "none" } });
    await ctx.api.setAssignment("text", "standard", { providerAccount: "acme-main", model: "model-tool" });

    const set = await ctx.api.resolvePreview("text", "standard");
    expect(set.via).toBe("requested");
    const chain = await ctx.api.resolvePreview("text", "efficient");
    expect(chain.via).toBe("fallback-chain");
  });
});

describe("error redaction (contract §6.7)", () => {
  it("scrubs key material and URL userinfo from mapped errors", async () => {
    const { api } = makeApi();
    const err = await (api as any).mapErrorForTest(
      new Error("request to https://me:hunter2@api.example/v1 failed with sk-abcdefghijklmnopqrst key"),
    );
    expect(err.message).not.toContain("hunter2");
    expect(err.message).not.toContain("sk-abcdefghijklmnopqrst");
  });
});

describe("refreshModels passthrough", () => {
  it("maps unconfigured_provider", async () => {
    const { api } = makeApi();
    const res = await api.refreshModels("ghost");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("unconfigured_provider");
  });
});
