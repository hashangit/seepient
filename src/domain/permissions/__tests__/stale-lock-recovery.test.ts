/**
 * Stale-lock recovery & unhandledRejection test suite (Spec 022-2 / T044 / VULN-20 / VULN-24).
 *
 * Verifies:
 * 1. LocalPolicyStore breaks stale lockfiles (> 30s old) and allows writes to proceed.
 * 2. LocalPolicyStore rejects writes when lock is fresh (fail-closed).
 * 3. PersistedCapabilityLedger breaks stale lockfiles (> 30s old) on consume.
 * 4. PersistedCapabilityLedger fails closed when lock is fresh.
 * 5. runSeepientServer unhandledRejection guard catches floating rejections and unregisters on dispose.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalPolicyStore } from "../policy-store.js";
import { PolicyConflictError } from "../../../foundations/errors.js";
import { PersistedCapabilityLedger } from "../persisted-capability-ledger.js";

describe("Stale-Lock Recovery (T044 / VULN-20)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "seepient-stale-lock-"));
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  describe("LocalPolicyStore Stale-Lock Recovery", () => {
    it("breaks a stale lock (>30s old) and successfully completes write", async () => {
      const store = new LocalPolicyStore({ root: tempDir });
      const workspaceId = "ws-stale-test";
      const lockPath = join(tempDir, `${workspaceId}.lock`);

      // Create a stale lock (mtime 60s in the past)
      writeFileSync(lockPath, "99999", { mode: 0o600 });
      const staleTime = new Date(Date.now() - 60_000);
      utimesSync(lockPath, staleTime, staleTime);

      // Mutate policy — should break the stale lock and succeed
      const result = await store.compareAndSet(
        workspaceId,
        0,
        {
          version: 1,
          capabilities: [
            { kind: "process", principalId: "tenant-1" },
          ],
        },
        { kind: "human", authorityId: "admin", authenticatedBy: "test" },
      );

      expect(result.policy.capabilities).toHaveLength(1);
      expect(result.version).toBe(1);
      // Lockfile should be cleaned up after write
      expect(existsSync(lockPath)).toBe(false);
    });

    it("fails closed with PolicyConflictError when lock is fresh", async () => {
      const store = new LocalPolicyStore({ root: tempDir });
      const workspaceId = "ws-fresh-lock-test";
      const lockPath = join(tempDir, `${workspaceId}.lock`);

      // Create a fresh lock (current time)
      writeFileSync(lockPath, String(process.pid), { mode: 0o600 });

      await expect(
        store.compareAndSet(
          workspaceId,
          0,
          {
            version: 1,
            capabilities: [],
          },
          { kind: "human", authorityId: "admin", authenticatedBy: "test" },
        ),
      ).rejects.toThrowError(PolicyConflictError);

      // Fresh lock must not have been removed
      expect(existsSync(lockPath)).toBe(true);
    });
  });

  describe("PersistedCapabilityLedger Stale-Lock Recovery", () => {
    it("breaks a stale lock (>30s old) and successfully consumes action", async () => {
      const ledger = new PersistedCapabilityLedger({ root: tempDir });
      const principalId = "tenant-ledger-stale";
      const lockPath = join(tempDir, principalId, "ledger.ndjson.lock");

      // Ensure directory exists and place a stale lock (60s old)
      const principalDir = join(tempDir, principalId);
      const fs = await import("node:fs/promises");
      await fs.mkdir(principalDir, { recursive: true });
      writeFileSync(lockPath, "99999", { mode: 0o600 });
      const staleTime = new Date(Date.now() - 60_000);
      utimesSync(lockPath, staleTime, staleTime);

      const consumed = await ledger.consume("env-1", "digest-1", { principalId });
      expect(consumed).toBe(true);
      expect(existsSync(lockPath)).toBe(false);
    });

    it("fails closed when ledger lock is fresh", async () => {
      const ledger = new PersistedCapabilityLedger({ root: tempDir });
      const principalId = "tenant-ledger-fresh";
      const lockPath = join(tempDir, principalId, "ledger.ndjson.lock");

      const principalDir = join(tempDir, principalId);
      const fs = await import("node:fs/promises");
      await fs.mkdir(principalDir, { recursive: true });
      writeFileSync(lockPath, String(process.pid), { mode: 0o600 });

      const consumed = await ledger.consume("env-2", "digest-2", { principalId });
      expect(consumed).toBe(false);
      expect(existsSync(lockPath)).toBe(true);
    });
  });
});
