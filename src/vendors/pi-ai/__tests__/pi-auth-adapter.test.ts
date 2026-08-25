/**
 * 013 T038 — pi-auth-adapter unit tests (M5.1 / contract provider-manager-api.md).
 * Tests pi-ai CredentialStore over Seepient credential store, serialized modify,
 * refresh token rotation, and flow availability.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CredentialStore } from "../../../foundations/contracts/credential-store.js";
import type { PersistedCredentialRecord } from "../../../foundations/schemas/credential-store.js";
import {
  createPiCredentialStore,
  AVAILABLE_OAUTH_FLOWS,
  getOAuthFlow,
} from "../pi-auth-adapter.js";
import type { OAuthCredential } from "@earendil-works/pi-ai";

function createMockCredentialStore(): CredentialStore {
  const store = new Map<string, PersistedCredentialRecord>();
  const now = new Date().toISOString();
  return {
    async resolve(ref: any) {
      return {
        id: ref.id ?? "mock",
        ref,
        async isResolvable() { return true; },
        acquireLease() {
          return {
            leaseId: "lease-1",
            secret: async () => ({ kind: "none" as const }),
            release: async () => {},
            isReleased: false,
          };
        },
        activeLeaseCount: 0,
      };
    },
    async get(id: string) {
      const rec = store.get(id);
      if (!rec) return undefined;
      return {
        id,
        materialKind: rec.kind,
        createdAt: now,
        updatedAt: now,
      };
    },
    async getRecord(id: string) {
      return store.get(id);
    },
    async put(id: string, record: PersistedCredentialRecord) {
      store.set(id, record);
    },
    async delete(id: string) {
      store.delete(id);
    },
    async list() {
      return Array.from(store.keys()).map((id) => ({
        id,
        materialKind: store.get(id)!.kind,
        createdAt: now,
        updatedAt: now,
      }));
    },
  };
}

const ROOT = join(import.meta.dirname, "..", "..");

describe("pi-auth-adapter: flow availability (T038)", () => {
  it("exposes exactly the seven bundled flows", () => {
    const expected = [
      "anthropic",
      "openai-codex",
      "github-copilot",
      "openrouter",
      "kimi-coding",
      "xai",
      "radius",
    ];
    expect([...AVAILABLE_OAUTH_FLOWS].sort()).toEqual(expected.sort());
  });

  it("loads flow loaders for supported upstreams", async () => {
    const flow = await getOAuthFlow("anthropic");
    expect(flow).toBeDefined();
    expect(flow?.name).toContain("Anthropic");

    const codex = await getOAuthFlow("openai-codex");
    expect(codex).toBeDefined();
  });

  it("never imports bun-oauth (R14)", () => {
    const adapterSource = readFileSync(join(ROOT, "pi-ai", "pi-auth-adapter.ts"), "utf8");
    expect(adapterSource).not.toContain("bun-oauth");
  });
});

describe("pi-auth-adapter: CredentialStore bridge (T038)", () => {
  it("read() returns undefined for non-existent credential", async () => {
    const seepientStore = createMockCredentialStore();
    const piStore = createPiCredentialStore(seepientStore);
    const result = await piStore.read("anthropic");
    expect(result).toBeUndefined();
  });

  it("modify() writes an OAuth credential and persists to Seepient store", async () => {
    const seepientStore = createMockCredentialStore();
    const piStore = createPiCredentialStore(seepientStore);

    const initialToken: OAuthCredential = {
      type: "oauth",
      access: "access-token-1",
      refresh: "refresh-token-1",
      expires: Date.now() + 3600_000,
    };

    const written = await piStore.modify("anthropic", async () => initialToken);
    expect(written).toEqual(initialToken);

    // Read back via piStore
    const readBack = await piStore.read("anthropic");
    expect(readBack).toEqual(initialToken);

    // Verify stored in Seepient store
    const seepientRecord = seepientStore.getRecord
      ? await seepientStore.getRecord("anthropic")
      : undefined;
    if (seepientRecord) {
      expect(seepientRecord.kind).toBe("oauth");
      if (seepientRecord.kind === "oauth") {
        expect(seepientRecord.refresh).toBe("refresh-token-1");
        expect(seepientRecord.access).toBe("access-token-1");
      }
    }
  });

  it("modify() serializes read-modify-writes across concurrent operations", async () => {
    const seepientStore = createMockCredentialStore();
    const piStore = createPiCredentialStore(seepientStore);

    let refreshCounter = 0;
    const initialToken: OAuthCredential = {
      type: "oauth",
      access: "access-token-0",
      refresh: "refresh-token-0",
      expires: Date.now() + 3600_000,
    };
    await piStore.modify("anthropic", async () => initialToken);

    // Run 3 concurrent modifications (e.g. concurrent token refreshes)
    const results = await Promise.all([
      piStore.modify("anthropic", async (curr) => {
        refreshCounter++;
        return {
          type: "oauth",
          access: `access-token-${refreshCounter}`,
          refresh: `refresh-token-${refreshCounter}`,
          expires: (curr as OAuthCredential)?.expires ?? 0,
        };
      }),
      piStore.modify("anthropic", async (curr) => {
        refreshCounter++;
        return {
          type: "oauth",
          access: `access-token-${refreshCounter}`,
          refresh: `refresh-token-${refreshCounter}`,
          expires: (curr as OAuthCredential)?.expires ?? 0,
        };
      }),
      piStore.modify("anthropic", async (curr) => {
        refreshCounter++;
        return {
          type: "oauth",
          access: `access-token-${refreshCounter}`,
          refresh: `refresh-token-${refreshCounter}`,
          expires: (curr as OAuthCredential)?.expires ?? 0,
        };
      }),
    ]);

    expect(results).toHaveLength(3);
    const finalRead = await piStore.read("anthropic") as OAuthCredential;
    expect(finalRead.refresh).toBe("refresh-token-3");
    expect(finalRead.access).toBe("access-token-3");
  });

  it("delete() removes the credential from Seepient store", async () => {
    const seepientStore = createMockCredentialStore();
    const piStore = createPiCredentialStore(seepientStore);

    await piStore.modify("anthropic", async () => ({
      type: "oauth",
      access: "access-1",
      refresh: "refresh-1",
      expires: Date.now() + 3600_000,
    }));

    expect(await piStore.read("anthropic")).toBeDefined();
    await piStore.delete("anthropic");
    expect(await piStore.read("anthropic")).toBeUndefined();
  });

  it("caches PiCredentialStoreAdapter per SeepientCredentialStore instance", () => {
    const seepientStore = createMockCredentialStore();
    const adapter1 = createPiCredentialStore(seepientStore);
    const adapter2 = createPiCredentialStore(seepientStore);
    expect(adapter1).toBe(adapter2);
  });

  it("P0-1 regression: real Anthropic OAuth flow runs with controller interaction shim and waits for abort without premature settle", async () => {
    const flow = await getOAuthFlow("anthropic");
    expect(flow).toBeDefined();

    const ac = new AbortController();
    let urlEmitted = false;
    let progressEmitted = false;

    const { createOAuthInteractionShim } = await import("../../../transport/cli/provider-manager-api.js");
    const interaction = createOAuthInteractionShim(
      {
        signal: ac.signal,
        onBrowserOpen: (url) => {
          urlEmitted = true;
          expect(url).toContain("claude.ai");
        },
        onWaiting: () => {
          progressEmitted = true;
        },
      },
      ac.signal,
    );

    const loginPromise = flow!.login(interaction as any);

    // The old buggy shim settled immediately with "" in <1ms causing "Missing authorization code"
    // The fixed shim remains pending while the browser callback waits
    await new Promise((r) => setTimeout(r, 100));

    expect(urlEmitted).toBe(true);

    // Abort cleanly stops the waiting flow
    ac.abort();
    await expect(loginPromise).rejects.toThrow();
  });

  it("openrouter regression: emits documented authorize URL shape and forwards auth_url instructions through the shim", async () => {
    const flow = await getOAuthFlow("openrouter");
    expect(flow).toBeDefined();

    const ac = new AbortController();
    let capturedUrl: string | undefined;
    let capturedInstructions: string | undefined;

    const { createOAuthInteractionShim } = await import("../../../transport/cli/provider-manager-api.js");
    const interaction = createOAuthInteractionShim(
      {
        signal: ac.signal,
        onBrowserOpen: (url, instructions) => {
          capturedUrl = url;
          capturedInstructions = instructions;
        },
      },
      ac.signal,
    );

    const loginPromise = flow!.login(interaction as any);
    await new Promise((r) => setTimeout(r, 250));

    // Documented OpenRouter PKCE shape (openrouter.ai/docs/oauth):
    // /auth with callback_url, code_challenge, code_challenge_method=S256.
    // A signed-out browser 307s to the general /sign-up page first — the flow
    // only reads as "broken" when the sign-in-first step is unexplained.
    expect(capturedUrl).toMatch(/^https:\/\/openrouter\.ai\/auth\?/);
    const params = new URL(capturedUrl!).searchParams;
    expect(params.get("callback_url")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback\//);
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("code_challenge")).toBeTruthy();

    // pi-ai's instructions string must survive the shim (dropping it hid the
    // "complete sign-in in your browser" guidance).
    expect(capturedInstructions).toBeTruthy();

    ac.abort();
    await expect(loginPromise).rejects.toThrow();
  });

  it("F1 regression: redacts secret tokens from warning log on failed keychain put", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failingStore: CredentialStore = {
      resolve: vi.fn(),
      get: vi.fn(),
      getRecord: vi.fn(),
      list: vi.fn(),
      put: vi.fn().mockRejectedValue(new Error('Command failed: security add-generic-password -w {"kind":"oauth","access":"sk-super-secret-token-12345678901234567890"}')),
      delete: vi.fn(),
    };

    const piStore = createPiCredentialStore(failingStore);
    await piStore.modify("test-oauth-provider", async () => {
      return {
        type: "oauth",
        access: "sk-super-secret-token-12345678901234567890",
        refresh: "refresh-token-val",
        expires: Date.now() + 3600_000,
      };
    });

    expect(warnSpy).toHaveBeenCalled();
    const loggedMessage = warnSpy.mock.calls[0]?.[0] as string;
    expect(loggedMessage).toContain("[REDACTED]");
    expect(loggedMessage).not.toContain("sk-super-secret-token-12345678901234567890");
    warnSpy.mockRestore();
  });

  it("P3-6 sync test: all bundled OAuth flows in AVAILABLE_OAUTH_FLOWS resolve valid flow definitions", async () => {
    for (const flowId of AVAILABLE_OAUTH_FLOWS) {
      const flow = await getOAuthFlow(flowId);
      expect(flow).toBeDefined();
      expect(typeof flow?.login).toBe("function");
    }
  });

  it("P1-1 regression: modify writes to matching record ID when accountId != canonical flowId", async () => {
    const records = new Map<string, PersistedCredentialRecord>();
    records.set("anthropic-work", {
      kind: "oauth",
      access: "access-token-1",
      refresh: "refresh-token-1",
      expires: Date.now() + 1000,
    });

    const metaMap = new Map<string, any>();
    metaMap.set("anthropic-work", { providerAccountHint: "anthropic", description: "Work account" });

    const now = new Date().toISOString();
    const store: CredentialStore = {
      resolve: vi.fn(),
      get: vi.fn(async (id: string) => {
        if (!records.has(id)) return undefined;
        return {
          id,
          source: "keychain" as const,
          materialKind: "oauth" as const,
          createdAt: now,
          updatedAt: now,
          meta: metaMap.get(id),
        };
      }),
      getRecord: vi.fn(async (id: string) => records.get(id)),
      list: vi.fn(async () => [
        {
          id: "anthropic-work",
          source: "keychain" as const,
          materialKind: "oauth" as const,
          createdAt: now,
          updatedAt: now,
          meta: metaMap.get("anthropic-work"),
        },
      ]),
      put: vi.fn(async (id: string, record: any, meta: any) => {
        records.set(id, record);
        if (meta) metaMap.set(id, meta);
      }),
      delete: vi.fn(async (id: string) => { records.delete(id); }),
    };

    const piStore = createPiCredentialStore(store);

    // Call modify using canonical name "anthropic", which should resolve and update "anthropic-work"
    await piStore.modify("anthropic", async (curr) => {
      expect(curr?.type).toBe("oauth");
      expect((curr as any)?.access).toBe("access-token-1");
      return {
        type: "oauth",
        access: "rotated-access-token-2",
        refresh: "rotated-refresh-token-2",
        expires: Date.now() + 3600_000,
      };
    });

    // The write must have targeted "anthropic-work", NOT "anthropic"
    expect(store.put).toHaveBeenCalledWith(
      "anthropic-work",
      expect.objectContaining({ access: "rotated-access-token-2" }),
      expect.anything(),
    );
    expect(records.has("anthropic")).toBe(false);
    expect((records.get("anthropic-work") as any)?.access).toBe("rotated-access-token-2");
  });
});
