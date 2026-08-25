import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  EnvCredentialStore,
  FileCredentialStore,
  KeychainCredentialStore,
  MemoryCredentialStore,
  CompositeCredentialStore,
} from "../index.js";
import { SeepientError } from "../../../../foundations/errors.js";

describe("CredentialStore implementations (QS-P4.1)", () => {
  describe("EnvCredentialStore", () => {
    const origEnv = process.env.TEST_PROVIDER_KEY;

    afterEach(() => {
      if (origEnv !== undefined) {
        process.env.TEST_PROVIDER_KEY = origEnv;
      } else {
        delete process.env.TEST_PROVIDER_KEY;
      }
    });

    it("resolves valid env var to a handle and yields raw secret on lease.secret()", async () => {
      process.env.TEST_PROVIDER_KEY = "sk-env-123";
      const store = new EnvCredentialStore();
      const handle = await store.resolve({ kind: "env", name: "TEST_PROVIDER_KEY" });

      expect(await handle.isResolvable()).toBe(true);
      expect(handle.activeLeaseCount).toBe(0);

      const lease = handle.acquireLease();
      expect(handle.activeLeaseCount).toBe(1);

      const secret = await lease.secret();
      expect(secret).toEqual({ kind: "api_key", value: "sk-env-123" });

      // Idempotent release
      await lease.release();
      expect(handle.activeLeaseCount).toBe(0);
      await lease.release();
      expect(handle.activeLeaseCount).toBe(0);

      // secret() throws if called after release
      await expect(lease.secret()).rejects.toThrow(SeepientError);
    });

    it("reflects rotated env var value on next lease.secret() call without subscription", async () => {
      process.env.TEST_PROVIDER_KEY = "sk-env-initial";
      const store = new EnvCredentialStore();
      const handle = await store.resolve({ kind: "env", name: "TEST_PROVIDER_KEY" });

      const lease = handle.acquireLease();
      expect(await lease.secret()).toEqual({ kind: "api_key", value: "sk-env-initial" });

      // Rotate env var
      process.env.TEST_PROVIDER_KEY = "sk-env-rotated";
      expect(await lease.secret()).toEqual({ kind: "api_key", value: "sk-env-rotated" });
      await lease.release();
    });
  });

  describe("MemoryCredentialStore", () => {
    it("stores, retrieves, lists, and deletes records", async () => {
      const store = new MemoryCredentialStore();
      await store.put("work-cred", { kind: "api_key", keyValue: "sk-mem-key" }, { description: "Work API key" });

      const record = await store.get("work-cred");
      expect(record).toBeDefined();
      expect(record?.id).toBe("work-cred");
      expect((record as any)?.keyValue).toBeUndefined(); // never returns secret in get()

      const handle = await store.resolve({ kind: "seepient", id: "work-cred" });
      const lease = handle.acquireLease();
      expect(await lease.secret()).toEqual({ kind: "api_key", value: "sk-mem-key" });
      await lease.release();

      const list = await store.list();
      expect(list.length).toBe(1);

      await store.delete("work-cred");
      expect(await store.get("work-cred")).toBeUndefined();
    });

    it("resolves kind: 'none' to a no-auth handle", async () => {
      const store = new MemoryCredentialStore();
      const handle = await store.resolve({ kind: "none" });
      expect(await handle.isResolvable()).toBe(true);

      const lease = handle.acquireLease();
      expect(await lease.secret()).toEqual({ kind: "none" });
      await lease.release();
    });
  });

  describe("FileCredentialStore", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "seepient-cred-test-"));
    });

    afterEach(() => {
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("atomically writes and resolves encrypted/persisted records", async () => {
      const store = new FileCredentialStore(tmpDir);
      await store.put("file-key-1", { kind: "api_key", keyValue: "sk-file-123" });

      const handle = await store.resolve({ kind: "seepient", id: "file-key-1" });
      expect(await handle.isResolvable()).toBe(true);

      const lease = handle.acquireLease();
      expect(await lease.secret()).toEqual({ kind: "api_key", value: "sk-file-123" });
      await lease.release();
    });
  });

  describe("KeychainCredentialStore", () => {
    it("throws KEYCHAIN_UNAVAILABLE when keychain provider is absent (no silent plaintext fallback)", async () => {
      const store = new KeychainCredentialStore(null);
      const handle = await store.resolve({ kind: "keychain", account: "test-user" });

      expect(await handle.isResolvable()).toBe(false);

      const lease = handle.acquireLease();
      try {
        await lease.secret();
        expect.fail("Should have thrown KEYCHAIN_UNAVAILABLE");
      } catch (err: any) {
        expect(err).toBeInstanceOf(SeepientError);
        expect(err.code).toBe("KEYCHAIN_UNAVAILABLE");
      }
    });

    it("resolves secret via platform keychain provider when available", async () => {
      const mockProvider = {
        getPassword: async (_service: string, _account: string) => "sk-keychain-secret",
        setPassword: async () => {},
        deletePassword: async () => true,
      };

      const store = new KeychainCredentialStore(mockProvider);
      const handle = await store.resolve({ kind: "keychain", account: "test-user" });

      expect(await handle.isResolvable()).toBe(true);
      const lease = handle.acquireLease();
      expect(await lease.secret()).toEqual({ kind: "api_key", value: "sk-keychain-secret" });
      await lease.release();
    });

    it("puts and gets persisted credential records round-trip via provider", async () => {
      const memory = new Map<string, string>();
      const mockProvider = {
        getPassword: async (service: string, account: string) => memory.get(`${service}/${account}`) ?? null,
        setPassword: async (service: string, account: string, password: string) => {
          memory.set(`${service}/${account}`, password);
        },
        deletePassword: async (service: string, account: string) => memory.delete(`${service}/${account}`),
      };

      const store = new KeychainCredentialStore(mockProvider);
      await store.put("kc-account", {
        kind: "oauth",
        access: "kc-access-123",
        refresh: "kc-refresh-456",
        expires: 1800000000,
      }, { description: "test oauth", providerAccountHint: "openai" });

      const rec = await store.getRecord("kc-account");
      expect(rec).toEqual({
        kind: "oauth",
        access: "kc-access-123",
        refresh: "kc-refresh-456",
        expires: 1800000000,
      });

      const meta = await store.get("kc-account");
      expect(meta?.meta?.providerAccountHint).toBe("openai");
    });
  });

  describe("CompositeCredentialStore", () => {
    it("routes resolution to appropriate store based on ref.kind", async () => {
      process.env.COMPOSITE_TEST_KEY = "sk-composite-env";
      const composite = new CompositeCredentialStore();

      // 1. Env
      const envHandle = await composite.resolve({ kind: "env", name: "COMPOSITE_TEST_KEY" });
      const envLease = envHandle.acquireLease();
      expect(await envLease.secret()).toEqual({ kind: "api_key", value: "sk-composite-env" });
      await envLease.release();

      // 2. None
      const noneHandle = await composite.resolve({ kind: "none" });
      const noneLease = noneHandle.acquireLease();
      expect(await noneLease.secret()).toEqual({ kind: "none" });
      await noneLease.release();
    });

    it("stores and resolves oauth credentials across composite layers (T040)", async () => {
      const memory = new MemoryCredentialStore();
      const composite = new CompositeCredentialStore({
        memory,
        primaryWriteStore: "memory",
      });

      await composite.put("oauth-user", {
        kind: "oauth",
        access: "acc-123",
        refresh: "ref-456",
        expires: 1730000000,
      });

      const rec = await composite.get("oauth-user");
      expect(rec).toBeDefined();
      expect(rec?.materialKind).toBe("oauth");

      const raw = await composite.getRecord("oauth-user");
      expect(raw).toEqual({
        kind: "oauth",
        access: "acc-123",
        refresh: "ref-456",
        expires: 1730000000,
      });
    });

    it("P0-2 regression: DefaultPlatformKeychainProvider on darwin passes secret via stdin and never in argv", async () => {
      const { DefaultPlatformKeychainProvider } = await import("../keychain-credential-store.js");

      let capturedArgs: readonly string[] = [];
      let capturedStdin = "";

      const fakeExecFile = (cmd: string, args: readonly string[], cb: any) => {
        capturedArgs = args;
        const fakeChild = {
          stdin: {
            on: () => fakeChild.stdin,
            write: (chunk: string) => { capturedStdin += chunk; },
            end: () => { cb(null); },
          },
        };
        return fakeChild as any;
      };

      const provider = new DefaultPlatformKeychainProvider(fakeExecFile as any, () => "darwin");
      await provider.setPassword("test-service", "test-account", "sk-secret-password-val");

      expect(capturedArgs).toContain("-w");
      // Password MUST NOT be present in argv
      expect(capturedArgs).not.toContain("sk-secret-password-val");
      expect(capturedArgs.join(" ")).not.toContain("sk-secret-password-val");
      // Password MUST be written to stdin
      expect(capturedStdin).toBe("sk-secret-password-val");
    });
  });
});
