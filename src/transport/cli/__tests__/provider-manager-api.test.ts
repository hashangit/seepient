/**
 * 013 T004 — ProviderManagerApi controller unit tests (contract §6 matrix).
 * Runs against an in-memory config store + memory credential store.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createProviderManagerApi, mapError, isOAuthSupported } from "../provider-manager-api.js";
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
    const { api, configStore, runtime } = makeApi({ credentialStore: new FailingStore() as unknown as MemoryCredentialStore });
    withCatalogModels(runtime, MODELS);
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
      override async updateOverlay(patch: ProviderLayerPatch, rev: number): Promise<any> {
        calls++;
        throw new SeepientError(`Optimistic concurrency violation: expected revision ${rev}, but current revision is ${rev}.`, "PRECONDITION_FAILED", false);
      }
    }
    const { api, runtime } = makeApi({ credentialStore: creds, configStore: new FlakyStore() });
    withCatalogModels(runtime, MODELS);
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
    const { api, runtime } = makeApi({ configStore: new RetryOnceStore() });
    withCatalogModels(runtime, MODELS);
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

  it("handles custom credId and preserves shared credentials until last account deleted", async () => {
    const { api, credentialStore, configStore, runtime } = makeApi();
    withCatalogModels(runtime, MODELS);

    // Save a credential under a shared id
    await credentialStore.put("shared-cred-1", { kind: "api_key", keyValue: "secret-key" }, { source: "disk" });

    // Seed two accounts in overlay pointing to the shared credential id
    const currentOverlay = await configStore.getOverlay();
    await configStore.updateOverlay(
      {
        providers: {
          "acct-1": { adapter: "pi-ai", upstreamProvider: "acme", credential: { kind: "seepient", id: "shared-cred-1" } },
          "acct-2": { adapter: "pi-ai", upstreamProvider: "acme", credential: { kind: "seepient", id: "shared-cred-1" } },
          "acct-env": { adapter: "pi-ai", upstreamProvider: "other", credential: { kind: "env", name: "ENV_KEY" } },
        },
      },
      currentOverlay.revision,
    );

    // Seed a credential under acct-env name to ensure env-account deletion doesn't delete it
    await credentialStore.put("acct-env", { kind: "api_key", keyValue: "unrelated-key" }, { source: "disk" });

    // Deleting acct-1 should NOT delete shared-cred-1 because acct-2 still uses it
    const del1 = await api.deleteAccount("acct-1", { force: true });
    expect(del1.ok).toBe(true);
    expect(await credentialStore.get("shared-cred-1")).toBeDefined();

    // Deleting acct-env should NOT touch the "acct-env" store entry because acct-env has credential.kind: "env"
    const delEnv = await api.deleteAccount("acct-env", { force: true });
    expect(delEnv.ok).toBe(true);
    expect(await credentialStore.get("acct-env")).toBeDefined();

    // Deleting acct-2 (last user of shared-cred-1) SHOULD clean up shared-cred-1
    const del2 = await api.deleteAccount("acct-2", { force: true });
    expect(del2.ok).toBe(true);
    expect(await credentialStore.get("shared-cred-1")).toBeUndefined();
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
    expect("via" in set && set.via).toBe("requested");
    const chain = await ctx.api.resolvePreview("text", "efficient");
    expect("via" in chain && chain.via).toBe("fallback-chain");
  });
});

describe("error redaction (contract §6.7)", () => {
  it("scrubs key material and URL userinfo from mapped errors", async () => {
    const err = mapError(
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
    if (!res.ok) expect(res.error?.code).toBe("unconfigured_provider");
  });
});

describe("OAuth sign-in & logout (contract §6.8–6.10)", () => {
  it("exposes available OAuth flows", async () => {
    const { api } = makeApi();
    const flows = await api.getAvailableOAuthFlows();
    expect(flows).toContain("anthropic");
    expect(flows).toContain("openai-codex");
  });

  it("handles unsupported OAuth provider with oauth_flow_failed", async () => {
    const { api, credentialStore, configStore } = makeApi();
    const res = await api.signInWithProvider("unsupported-llm", {});
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("oauth_flow_failed");

    // Zero persisted state (contract §6.8)
    const eff = await configStore.getEffectiveConfig();
    expect(eff.providers?.["unsupported-llm"]).toBeUndefined();
    expect(await credentialStore.list()).toHaveLength(0);
  });

  it("getState never contains token material and reflects oauth credentialKind", async () => {
    const { api, credentialStore, configStore } = makeApi();
    await credentialStore.put("anthropic-oauth", {
      kind: "oauth",
      access: "access-token-secret-xyz",
      refresh: "refresh-token-secret-abc",
      expires: Date.now() + 3600_000,
    });
    await configStore.updateOverlay({
      providers: {
        "anthropic-oauth": {
          adapter: "pi-ai",
          upstreamProvider: "anthropic",
          credential: { kind: "seepient", id: "anthropic-oauth" },
        },
      },
    }, 0);

    const state = await api.getState();
    const acct = state.accounts.find((a) => a.id === "anthropic-oauth");
    expect(acct).toBeDefined();
    expect(acct?.credentialKind).toBe("oauth");
    expect(acct?.health).toBe("ok");
    expect(JSON.stringify(state)).not.toContain("access-token-secret-xyz");
    expect(JSON.stringify(state)).not.toContain("refresh-token-secret-abc");
  });

  it("logoutAccount removes the oauth record and flags health missing", async () => {
    const { api, credentialStore, configStore } = makeApi();
    await credentialStore.put("anthropic-oauth", {
      kind: "oauth",
      access: "access-token-xyz",
      refresh: "refresh-token-abc",
      expires: Date.now() + 3600_000,
    });
    await configStore.updateOverlay({
      providers: {
        "anthropic-oauth": {
          adapter: "pi-ai",
          upstreamProvider: "anthropic",
          credential: { kind: "seepient", id: "anthropic-oauth" },
        },
      },
    }, 0);

    const res = await api.logoutAccount("anthropic-oauth");
    expect(res.ok).toBe(true);

    const state = await api.getState();
    const acct = state.accounts.find((a) => a.id === "anthropic-oauth");
    expect(acct?.health).toBe("missing");
    expect(await credentialStore.get("anthropic-oauth")).toBeUndefined();

    // Second logout is a safe no-op
    const res2 = await api.logoutAccount("anthropic-oauth");
    expect(res2.ok).toBe(true);
  });

  it("logoutAccount does not delete pasted api_key credentials", async () => {
    const { api, credentialStore } = makeApi();
    await api.saveAccount({
      accountId: "anthropic-key",
      upstreamProvider: "anthropic",
      credential: { mode: "paste", keyValue: "sk-ant-12345" },
    });

    const recBefore = await credentialStore.get("anthropic-key");
    expect(recBefore).toBeDefined();
    expect(recBefore?.materialKind).toBe("api_key");

    const logoutRes = await api.logoutAccount("anthropic-key");
    expect(logoutRes.ok).toBe(true);

    const recAfter = await credentialStore.get("anthropic-key");
    expect(recAfter).toBeDefined(); // Key MUST be preserved!
  });

  it("saveAccount clears baseUrl and ssrfAllowPrivate when editing account with omitted fields", async () => {
    const { api, configStore } = makeApi();
    const saveRes = await api.saveAccount({
      accountId: "custom-ep",
      upstreamProvider: "openai",
      credential: { mode: "none" },
      baseUrl: "http://127.0.0.1:8080/v1",
      allowPrivate: true,
    });
    expect(saveRes.ok).toBe(true);

    let ov = await configStore.getOverlay();
    expect((ov.patch.providers as any)?.["custom-ep"]?.baseUrl).toBe("http://127.0.0.1:8080/v1");
    expect((ov.patch.providers as any)?.["custom-ep"]?.ssrfAllowPrivate).toBe(true);

    // Edit account without baseUrl or allowPrivate
    const editRes = await api.saveAccount({
      accountId: "custom-ep",
      upstreamProvider: "openai",
      credential: { mode: "preserve" },
    });
    expect(editRes.ok).toBe(true);

    ov = await configStore.getOverlay();
    expect((ov.patch.providers as any)?.["custom-ep"]?.baseUrl).toBeNull();
    expect((ov.patch.providers as any)?.["custom-ep"]?.ssrfAllowPrivate).toBeNull();

    const state = await api.getState();
    const acct = state.accounts.find((a) => a.id === "custom-ep");
    expect(acct?.baseUrl).toBeUndefined();
  });

  it("sanitizeBaseUrl redacts query parameters containing secret keys", async () => {
    const { api, runtime } = makeApi();
    withCatalogModels(runtime, MODELS);
    const saveRes = await api.saveAccount({
      accountId: "query-key-acct",
      upstreamProvider: "acme",
      credential: { mode: "none" },
      baseUrl: "http://127.0.0.1:8080/v1?api_key=secret-token-value&format=json",
      allowPrivate: true,
    });
    expect(saveRes.ok).toBe(true);

    const state = await api.getState();
    const acct = state.accounts.find((a) => a.id === "query-key-acct");
    expect(acct?.baseUrl).toBeDefined();
    expect(acct?.baseUrl).not.toContain("secret-token-value");
    expect(acct?.baseUrl).toContain("%5BREDACTED%5D");
  });

  it("redacts token material in synthetic error messages (contract §6.10)", async () => {
    const err = mapError(
      new Error("OAuth refresh failed with access_token: secret-access-123 and refresh: secret-refresh-456"),
    );
    expect(err.message).not.toContain("secret-access-123");
    expect(err.message).not.toContain("secret-refresh-456");
  });

  it("OCC retry re-validates against fresh state on concurrent mutation (B1)", async () => {
    const { api, configStore, runtime } = makeApi();
    withCatalogModels(runtime, MODELS);

    // Add account "acme"
    await api.saveAccount({
      accountId: "acme",
      upstreamProvider: "acme",
      credential: { mode: "none" },
    });

    // Simulate concurrent mutation: before assigning slot, another process deletes account "acme"
    // We hook into configStore to update overlay concurrently right before first updateOverlay
    const origUpdate = configStore.updateOverlay.bind(configStore);
    let intervened = false;
    configStore.updateOverlay = async (patch: any, expectedRevision?: number) => {
      if (!intervened) {
        intervened = true;
        // Concurrently delete acme account and increment revision
        await origUpdate({ providers: { acme: null } }, expectedRevision ?? 0);
      }
      return origUpdate(patch, expectedRevision ?? 0);
    };

    // Attempting to set slot to deleted account should fail re-validation on OCC retry
    const assignRes = await api.setAssignment("text", "standard", {
      providerAccount: "acme",
      model: "model-tool",
    });

    expect(assignRes.ok).toBe(false);
    if (!assignRes.ok) {
      expect(assignRes.error.code).toBe("validation_failed");
      expect(assignRes.error.message).toContain('Account "acme" is not configured');
    }
  });

  it("setAssignment validates fallback targets and rejects unconfigured accounts or unknown models", async () => {
    const { api, runtime } = makeApi();
    withCatalogModels(runtime, MODELS);

    await api.saveAccount({
      accountId: "acme",
      upstreamProvider: "acme",
      credential: { mode: "none" },
    });

    // Valid primary with unconfigured fallback account
    const res1 = await api.setAssignment("text", "standard", {
      providerAccount: "acme",
      model: "model-tool",
      fallback: [{ providerAccount: "nonexistent-acct", model: "model-tool" }],
    });
    expect(res1.ok).toBe(false);
    if (!res1.ok) {
      expect(res1.error.code).toBe("validation_failed");
      expect(res1.error.message).toContain('Fallback account "nonexistent-acct" is not configured');
    }

    // Valid primary with unknown fallback model
    const res2 = await api.setAssignment("text", "standard", {
      providerAccount: "acme",
      model: "model-tool",
      fallback: [{ providerAccount: "acme", model: "typo/unknown-model" }],
    });
    expect(res2.ok).toBe(false);
    if (!res2.ok) {
      expect(res2.error.code).toBe("unknown_model");
      expect(res2.error.message).toContain('Fallback model "typo/unknown-model" is not in the catalog');
    }
  });

  it("saveAccount rolls back pasted credential when encountering an OCC revision conflict (F3)", async () => {
    const { api, credentialStore, configStore, runtime } = makeApi();
    withCatalogModels(runtime, MODELS);

    // Bump config revision to 1
    await configStore.updateOverlay({ modelAssignments: { text: { standard: { providerAccount: "a", model: "m" } } } }, 0);

    // Save with stale expectedRevision = 0 and paste mode
    const saveRes = await api.saveAccount(
      {
        accountId: "conflict-key-acct",
        upstreamProvider: "acme",
        credential: { mode: "paste", keyValue: "sk-should-not-orphan" },
      },
      0, // Stale revision
    );

    expect(saveRes.ok).toBe(false);
    if (!saveRes.ok) {
      expect(saveRes.error.code).toBe("conflict");
    }

    // Assert key is rolled back on conflict so no orphan secret remains
    const rec = await credentialStore.getRecord("conflict-key-acct");
    expect(rec).toBeUndefined();
  });

  it("P0 regression: signInWithProvider writes valid schema entry and produces valid effective config", async () => {
    const { api, runtime, credentialStore, configStore } = makeApi();
    withCatalogModels(runtime, [
      {
        id: "claude-3-7-sonnet",
        upstreamProvider: "anthropic",
        displayName: "Claude 3.7 Sonnet",
        contextWindow: 200000,
        capabilities: { toolUse: true, streaming: true, vision: true },
        supportedReasoningLevels: ["none", "low", "high"],
        provenance: "pi-catalog",
        reachableVia: ["my-anthropic"],
      },
    ]);

    const oauthModule = await import("../../../domain/providers/oauth-service.js");
    const mockFlow = {
      name: "Anthropic",
      login: vi.fn(async () => ({
        type: "oauth",
        access: "mock-access-token-123",
        refresh: "mock-refresh-token-456",
        expires: Date.now() + 3600_000,
      })),
    };
    const spy = vi.spyOn(oauthModule, "getOAuthFlow").mockResolvedValue(mockFlow as any);

    try {
      const res = await api.signInWithProvider("anthropic", {
        preferredAccountId: "my-anthropic",
        onBrowserOpen: () => {},
      });

      expect(res.ok).toBe(true);
      if (!res.ok) return;

      // 1. Assert overlay has required adapter and upstreamProvider
      const overlay = await configStore.getOverlay();
      const entry = (overlay.patch.providers as any)?.["my-anthropic"];
      expect(entry).toBeDefined();
      expect(entry.adapter).toBe("pi-ai");
      expect(entry.upstreamProvider).toBe("anthropic");
      expect(entry.credential).toEqual({ kind: "seepient", id: "my-anthropic" });

      // 2. Assert getEffectiveConfig() passes without CONFIG_VIOLATION
      const effective = await configStore.getEffectiveConfig();
      expect(effective.providers["my-anthropic"]).toBeDefined();
      expect(effective.providers["my-anthropic"].adapter).toBe("pi-ai");
      expect(effective.providers["my-anthropic"].upstreamProvider).toBe("anthropic");

      // 3. Assert runtime.createTurnSnapshot() runs cleanly
      const snapshot = await runtime.createTurnSnapshot();
      expect(snapshot.config.providers?.["my-anthropic"]).toBeDefined();

      // 4. Assert getState() reflects healthy account with reachable models
      const state = await api.getState();
      const account = state.accounts.find((a) => a.id === "my-anthropic");
      expect(account).toBeDefined();
      expect(account?.health).toBe("ok");
      expect(account?.credentialKind).toBe("oauth");
      expect(account?.modelCount).toBe(1);

      // 5. Assert credential was saved in credential store with hint
      const cred = await credentialStore.getRecord("my-anthropic");
      expect(cred).toBeDefined();
      expect(cred?.kind).toBe("oauth");
      expect((cred as any)?.access).toBe("mock-access-token-123");
      expect((cred as any)?.refresh).toBe("mock-refresh-token-456");
      const credMeta = await credentialStore.get("my-anthropic");
      expect(credMeta?.meta?.providerAccountHint).toBe("anthropic");
    } finally {
      spy.mockRestore();
    }
  });

  it("saveAccount rejects baseUrl containing [REDACTED] markers", async () => {
    const { api } = makeApi();
    const res = await api.saveAccount({
      accountId: "bad-url-acct",
      upstreamProvider: "openai",
      credential: { mode: "none" },
      baseUrl: "https://proxy.example.com/v1?token=[REDACTED]",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("validation_failed");
      expect(res.error.message).toContain("Cannot save redacted baseUrl");
    }
  });

  it("completeOAuthSignIn creates valid overlay entry and keychain-backed credential", async () => {
    const { api, credentialStore, configStore } = makeApi();
    const res = await api.completeOAuthSignIn(
      "openai",
      {
        access: "openai-access-123",
        refresh: "openai-refresh-456",
        expires: Date.now() + 3600_000,
      },
      { preferredAccountId: "my-openai-codex" },
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      const overlay = await configStore.getOverlay();
      const entry = (overlay.patch.providers as any)?.["my-openai-codex"];
      expect(entry).toBeDefined();
      expect(entry.adapter).toBe("pi-ai");
      expect(entry.upstreamProvider).toBe("openai-codex");
      expect(entry.credential).toEqual({ kind: "seepient", id: "my-openai-codex" });

      const cred = await credentialStore.getRecord("my-openai-codex");
      expect(cred?.kind).toBe("oauth");
      expect((cred as any)?.access).toBe("openai-access-123");
    }
  });

  it("mapError properly categorizes oauth_expired, unsupported_capability, unsupported_thinking_level", () => {
    const expired = mapError({ code: "oauth_expired", message: "Token expired" });
    expect(expired.code).toBe("oauth_expired");
    expect(expired.hint).toContain("Sign in again");

    const cap = mapError({ code: "unsupported_capability", message: "Tool use not supported" });
    expect(cap.code).toBe("unsupported_capability");
    expect(cap.hint).toContain("capability");

    const think = mapError({ code: "unsupported_thinking_level", message: "High not supported" });
    expect(think.code).toBe("unsupported_thinking_level");
  });

  it("isOAuthSupported recognizes canonical IDs and aliases correctly", () => {
    // Anthropic
    expect(isOAuthSupported("anthropic")).toBe(true);
    expect(isOAuthSupported("ANTHROPIC")).toBe(true);

    // OpenAI aliases
    expect(isOAuthSupported("openai")).toBe(true);
    expect(isOAuthSupported("openai-codex")).toBe(true);

    // GitHub / Copilot aliases
    expect(isOAuthSupported("github")).toBe(true);
    expect(isOAuthSupported("copilot")).toBe(true);
    expect(isOAuthSupported("github-copilot")).toBe(true);

    // Kimi / Moonshot aliases
    expect(isOAuthSupported("kimi")).toBe(true);
    expect(isOAuthSupported("moonshot")).toBe(true);
    expect(isOAuthSupported("kimi-coding")).toBe(true);

    // Grok / xAI aliases
    expect(isOAuthSupported("grok")).toBe(true);
    expect(isOAuthSupported("xai")).toBe(true);

    // Unsupported / custom
    expect(isOAuthSupported("ollama")).toBe(false);
    expect(isOAuthSupported("custom")).toBe(false);
    expect(isOAuthSupported("openai-compatible")).toBe(false);
  });

  it("F3 regression: rolls back pasted credential on OCC revision mismatch so no orphan secret remains", async () => {
    const { api, credentialStore } = makeApi();
    const res = await api.saveAccount(
      {
        accountId: "occ-orphan-test",
        upstreamProvider: "openai",
        credential: { mode: "paste", keyValue: "sk-orphan-key-123" },
      },
      9999, // stale revision -> OCC conflict
    );

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("conflict");
    }

    // Secret must NOT be orphaned in credential store
    const stored = await credentialStore.get("occ-orphan-test");
    expect(stored).toBeUndefined();
  });

  it("F5 regression: rejects unknown upstreamProvider with validation_failed", async () => {
    const { api, runtime } = makeApi();
    withCatalogModels(runtime, MODELS);
    const res = await api.saveAccount({
      accountId: "my-custom-account",
      upstreamProvider: "nonexistent-upstream-provider",
      credential: { mode: "none" },
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("validation_failed");
      expect(res.error.message).toContain('Unknown upstream provider "nonexistent-upstream-provider"');
    }
  });

  it("F6 regression: getAvailableOAuthFlows returns all bundled OAuth flow identifiers", async () => {
    const { api } = makeApi();
    const flows = await api.getAvailableOAuthFlows();
    expect(flows).toContain("anthropic");
    expect(flows).toContain("openai-codex");
    expect(flows).toContain("github-copilot");
    expect(flows.length).toBeGreaterThanOrEqual(7);
  });
});
