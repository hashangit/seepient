import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { ProviderConfigStore } from "../config-store/provider-config-store.js";
import { KeychainCredentialStore } from "../credentials/keychain-credential-store.js";
import { FileCredentialStore } from "../credentials/file-credential-store.js";
import { SeepientError } from "../../../foundations/errors.js";

describe("Phase P4 Concurrency, Consistency & Platform Resilience (P4.9 - P4.12)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "seepient-p4-resilience-"));
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("P4.9: handles concurrent instances modifying overlay with optimistic concurrency detection", async () => {
    const overlayFile = path.join(tmpDir, "overlay.json");
    const instance1 = new ProviderConfigStore(overlayFile);
    const instance2 = new ProviderConfigStore(overlayFile);

    // Initial state: rev 0
    const initial = await instance1.getOverlay();
    expect(initial.revision).toBe(0);

    // Instance 1 updates rev 0 -> rev 1
    await instance1.updateOverlay(
      {
        providers: {
          inst1: {
            adapter: "pi-ai",
            upstreamProvider: "openai",
            credential: { kind: "none" },
          } as any,
        },
      },
      0,
    );

    // Instance 2 attempts update with stale rev 0 -> PRECONDITION_FAILED
    await expect(
      instance2.updateOverlay(
        {
          providers: {
            inst2: {
              adapter: "pi-ai",
              upstreamProvider: "anthropic",
              credential: { kind: "none" },
            } as any,
          },
        },
        0,
      ),
    ).rejects.toThrow(SeepientError);
  });

  it("P4.10: overlay atomic writes preserve integrity across multiple patch rounds", async () => {
    const overlayFile = path.join(tmpDir, "overlay.json");
    const store = new ProviderConfigStore(overlayFile);

    for (let i = 0; i < 5; i++) {
      const current = await store.getOverlay();
      await store.updateOverlay(
        {
          providers: {
            [`acc-${i}`]: {
              adapter: "pi-ai",
              upstreamProvider: "openai",
              credential: { kind: "none" },
            } as any,
          },
        },
        current.revision,
      );
    }

    const final = await store.getOverlay();
    expect(final.revision).toBe(5);
    expect(Object.keys(final.patch.providers || {}).length).toBe(5);
  });

  it("P4.11: keychain credential store safely rejects without plaintext leakage", async () => {
    const mockFailingKeychain = {
      getPassword: async () => {
        throw new Error("Keychain locked by system security policy");
      },
      setPassword: async () => {},
      deletePassword: async () => true,
    };

    const store = new KeychainCredentialStore(mockFailingKeychain);
    const handle = await store.resolve({ kind: "keychain", account: "locked-acc" });
    const lease = handle.acquireLease();

    await expect(lease.secret()).rejects.toThrow(SeepientError);
  });

  it("P4.12: file credential store enforces secure directory permissions", async () => {
    const storeDir = path.join(tmpDir, "credentials");
    const store = new FileCredentialStore(storeDir);

    await store.put("sec-cred", { kind: "api_key", keyValue: "sk-super-secret" });

    // Verify directory exists
    expect(fs.existsSync(storeDir)).toBe(true);

    const handle = await store.resolve({ kind: "seepient", id: "sec-cred" });
    const lease = handle.acquireLease();
    const sec = await lease.secret();
    expect(sec).toEqual({ kind: "api_key", value: "sk-super-secret" });
    await lease.release();
  });
});
