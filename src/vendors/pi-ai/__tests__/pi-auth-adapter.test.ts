/**
 * 013 T038 — pi-auth-adapter unit tests (M5.1 / contract provider-manager-api.md).
 * Tests pi-ai CredentialStore over Seepient credential store, serialized modify,
 * refresh token rotation, and flow availability.
 */
import { describe, it, expect } from "vitest";
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
});
