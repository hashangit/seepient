import { beforeEach, describe, expect, it, vi } from "vitest";
import { retireModelCredential } from "@seepients/db";
import {
  DurableModelCredentialStore,
  type DurableStoreSecretStore,
} from "./durable-model-credential-store.js";
import { serializeModelSecret } from "./pi-oauth.js";

vi.mock("@seepients/db", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, retireModelCredential: vi.fn(async () => true) };
});

const SCOPE = { userId: "u1", spaceId: "s1" };
const HANDLE = { credentialId: "cred-1", secretId: "sec-1" };

beforeEach(() => {
  vi.clearAllMocks();
});

function oauthSecret(material: {
  access: string;
  refresh: string;
  expires: number;
  maxTokens?: number;
}) {
  return serializeModelSecret({
    kind: "oauth",
    credential: {
      type: "oauth",
      access: material.access,
      refresh: material.refresh,
      expires: material.expires,
    },
    ...(material.maxTokens !== undefined ? { maxTokens: material.maxTokens } : {}),
  });
}

function fixture(initialCiphertext: string) {
  const row = { id: HANDLE.secretId, ciphertext: initialCiphertext, createdAt: new Date() };
  const secret = {
    findFirst: vi.fn(async () => ({ ...row })),
    update: vi.fn(async ({ data }: { data: { ciphertext: string } }) => {
      row.ciphertext = data.ciphertext;
      return row;
    }),
  };
  const secretStore = {
    load: vi.fn(async (ciphertext: string) => ciphertext),
    put: vi.fn(async (plaintext: string) => ({ ciphertext: plaintext })),
  };
  const prisma = { secret, $transaction: vi.fn() };
  return { row, prisma, secretStore: secretStore as unknown as DurableStoreSecretStore };
}

function makeStore(f: ReturnType<typeof fixture>) {
  return new DurableModelCredentialStore({
    prisma: f.prisma as never,
    secretStore: f.secretStore,
    scope: SCOPE,
    handle: HANDLE,
    accountId: "seepients-app-model-key",
    provider: "anthropic",
  });
}

describe("DurableModelCredentialStore (T010 fences)", () => {
  it("getRecord decrypts and returns the current oauth material", async () => {
    const f = fixture(oauthSecret({ access: "a1", refresh: "r1", expires: 100 }));
    const store = makeStore(f);
    await expect(store.getRecord("seepients-app-model-key")).resolves.toEqual({
      kind: "oauth",
      access: "a1",
      refresh: "r1",
      expires: 100,
    });
    expect(f.secretStore.load).toHaveBeenCalledWith(
      oauthSecret({ access: "a1", refresh: "r1", expires: 100 }),
      HANDLE.secretId,
    );
  });

  it("put writes the rotated token through the persist fence", async () => {
    const f = fixture(oauthSecret({ access: "a1", refresh: "r1", expires: 100, maxTokens: 4096 }));
    const store = makeStore(f);
    await store.put("seepients-app-model-key", {
      kind: "oauth",
      access: "a2",
      refresh: "r2",
      expires: 200,
    });
    expect(f.secretStore.put).toHaveBeenCalledExactlyOnceWith(
      oauthSecret({ access: "a2", refresh: "r2", expires: 200, maxTokens: 4096 }),
      expect.objectContaining({ userId: SCOPE.userId, spaceId: SCOPE.spaceId }),
      { recordId: HANDLE.secretId },
    );
    expect(f.prisma.secret.update).toHaveBeenCalledExactlyOnceWith({
      where: { id: HANDLE.secretId },
      data: { ciphertext: oauthSecret({ access: "a2", refresh: "r2", expires: 200, maxTokens: 4096 }) },
    });
  });

  it("put never overwrites a newer stored token (freshness CAS)", async () => {
    const f = fixture(oauthSecret({ access: "new", refresh: "r-new", expires: 999 }));
    const store = makeStore(f);
    await store.put("seepients-app-model-key", {
      kind: "oauth",
      access: "old",
      refresh: "r-old",
      expires: 100,
    });
    expect(f.secretStore.put).not.toHaveBeenCalled();
    expect(f.prisma.secret.update).not.toHaveBeenCalled();
  });

  it("put is a no-op for identical material", async () => {
    const f = fixture(oauthSecret({ access: "a1", refresh: "r1", expires: 100 }));
    const store = makeStore(f);
    await store.put("seepients-app-model-key", {
      kind: "oauth",
      access: "a1",
      refresh: "r1",
      expires: 100,
    });
    expect(f.secretStore.put).not.toHaveBeenCalled();
  });

  it("put refuses api-key material — classes never cross", async () => {
    const f = fixture(oauthSecret({ access: "a1", refresh: "r1", expires: 100 }));
    const store = makeStore(f);
    await expect(
      store.put("seepients-app-model-key", { kind: "api_key", keyValue: "sk-x" }),
    ).rejects.toMatchObject({ message: expect.stringContaining("CREDENTIAL_CLASS_MISMATCH") });
  });

  it("delete retires with the captured failed-secret state (stale failure cannot delete newer material)", async () => {
    const f = fixture(oauthSecret({ access: "a1", refresh: "r1", expires: 100 }));
    const store = makeStore(f);
    // The run last saw a1/r1/100 — that becomes the failed state.
    await store.getRecord("seepients-app-model-key");
    f.row.ciphertext = oauthSecret({ access: "a2", refresh: "r2", expires: 200 });
    await store.delete("seepients-app-model-key");
    expect(vi.mocked(retireModelCredential)).toHaveBeenCalledExactlyOnceWith(
      f.prisma,
      expect.objectContaining({
        userId: SCOPE.userId,
        credentialId: HANDLE.credentialId,
        secretId: HANDLE.secretId,
      }),
    );
    // The fence predicate compares against the captured stale state: against
    // the NEWER row it must return false (nothing deleted), against the row
    // the run actually saw it must return true.
    const input = vi.mocked(retireModelCredential).mock.calls.at(-1)?.[1];
    if (!input?.matchesFailedSecret) throw new Error("expected a failed-secret guard");
    await expect(
      input.matchesFailedSecret({ id: HANDLE.secretId, ciphertext: f.row.ciphertext }),
    ).resolves.toBe(false);
    await expect(
      input.matchesFailedSecret({
        id: HANDLE.secretId,
        ciphertext: oauthSecret({ access: "a1", refresh: "r1", expires: 100 }),
      }),
    ).resolves.toBe(true);
  });

  it("delete without a prior read still retires, without a failed-secret guard", async () => {
    const f = fixture(oauthSecret({ access: "a1", refresh: "r1", expires: 100 }));
    const store = makeStore(f);
    await store.delete("seepients-app-model-key");
    const input = vi.mocked(retireModelCredential).mock.calls.at(-1)?.[1];
    expect(input).toMatchObject({
      userId: SCOPE.userId,
      credentialId: HANDLE.credentialId,
      secretId: HANDLE.secretId,
    });
    expect(input?.matchesFailedSecret).toBeUndefined();
  });

  it("lease secrets read the live row so a concurrent refresh is picked up", async () => {
    const f = fixture(oauthSecret({ access: "a1", refresh: "r1", expires: 100 }));
    const store = makeStore(f);
    const handle = await store.resolve({ kind: "seepient", id: "seepients-app-model-key" });
    const lease = handle.acquireLease();
    const first = await lease.secret();
    expect(first).toMatchObject({ kind: "pi_oauth" });
    f.row.ciphertext = oauthSecret({ access: "a2", refresh: "r2", expires: 200 });
    const second = await lease.secret();
    if (second.kind !== "pi_oauth") throw new Error("expected pi_oauth secret after refresh");
    const refreshed = second.piAuthContext;
    if (refreshed.kind !== "oauth") throw new Error("expected oauth record after refresh");
    expect(refreshed.access).toBe("a2");
    await lease.release();
  });

  it("resolve refuses foreign refs and foreign account ids", async () => {
    const f = fixture(oauthSecret({ access: "a1", refresh: "r1", expires: 100 }));
    const store = makeStore(f);
    await expect(store.resolve({ kind: "env", id: "x" })).rejects.toMatchObject({
      message: expect.stringContaining("CREDENTIAL_REQUIRED"),
    });
    await expect(store.getRecord("other-key")).resolves.toBeUndefined();
    await expect(store.get("other-key")).resolves.toBeUndefined();
  });
});
