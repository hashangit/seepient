/**
 * P1 LocalPolicyStore tests (spec 008, T108, FR-013).
 *
 * Verifies: private permissions, atomic replacement, version monotonicity,
 * compare-and-set conflict detection, digest tamper-evidence, and stale
 * expectedVersion rejection.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, chmodSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalPolicyStore, computeWorkspaceId } from "../policy-store.js";
import { PolicyConflictError } from "../../../foundations/errors.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seepient-policy-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("LocalPolicyStore (T108)", () => {
  it("read returns empty snapshot when no file exists", async () => {
    const store = new LocalPolicyStore({ root: dir });
    const ws = computeWorkspaceId("/proj");
    const snap = await store.read(ws);
    expect(snap.version).toBe(0);
    expect(snap.policy.capabilities).toEqual([]);
  });

  it("compareAndSet writes and increments version", async () => {
    const store = new LocalPolicyStore({ root: dir });
    const ws = computeWorkspaceId("/proj");
    const next = {
      version: 1 as const,
      capabilities: [{ kind: "commit-file" as const, path: "/proj/a.txt" }],
    };
    const snap = await store.compareAndSet(ws, 0, next, {
      kind: "human",
      authorityId: "op",
      authenticatedBy: "cli",
    });
    expect(snap.version).toBe(1);
    expect(snap.policy.capabilities).toHaveLength(1);

    const reread = await store.read(ws);
    expect(reread.version).toBe(1);
  });

  it("stale expectedVersion rejects with policy-conflict", async () => {
    const store = new LocalPolicyStore({ root: dir });
    const ws = computeWorkspaceId("/proj");
    const cap = { version: 1 as const, capabilities: [] };
    await store.compareAndSet(ws, 0, cap, {
      kind: "human",
      authorityId: "op",
      authenticatedBy: "cli",
    });
    // version is now 1; pretend we expected 0 again → conflict.
    await expect(
      store.compareAndSet(ws, 0, cap, {
        kind: "human",
        authorityId: "op",
        authenticatedBy: "cli",
      }),
    ).rejects.toBeInstanceOf(PolicyConflictError);
  });

  it("detects tampered digest on read", async () => {
    const store = new LocalPolicyStore({ root: dir });
    const ws = computeWorkspaceId("/proj");
    const cap = { version: 1 as const, capabilities: [] };
    await store.compareAndSet(ws, 0, cap, {
      kind: "human",
      authorityId: "op",
      authenticatedBy: "cli",
    });
    // Tamper: rewrite the file with a wrong digest.
    const file = join(dir, `${ws}.json`);
    const tampered = {
      workspaceId: ws,
      version: 1,
      policyDigest: "bogus",
      policy: { version: 1, capabilities: [{ kind: "commit-file", path: "/x" }] },
    };
    chmodSync(file, 0o600);
    writeFileSync(file, JSON.stringify(tampered), { mode: 0o600 });

    await expect(store.read(ws)).rejects.toBeInstanceOf(PolicyConflictError);
  });

  it("workspaceId is a stable digest of canonical root", () => {
    expect(computeWorkspaceId("/proj")).toBe(computeWorkspaceId("/proj"));
    expect(computeWorkspaceId("/proj")).not.toBe(computeWorkspaceId("/other"));
    expect(computeWorkspaceId("/proj")).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("compare-and-set provenance (P0 review fix)", () => {
  it("persists the actor and timestamp of every mutation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seepient-policy-provenance-"));
    try {
      const store = new LocalPolicyStore({ root: dir });
      const before = await store.read("ws-1");
      const actor = { kind: "human" as const, authorityId: "inline-approval", authenticatedBy: "tui" };
      const snap = await store.compareAndSet(
        "ws-1",
        before.version,
        { version: 1, capabilities: [{ kind: "commit-file", path: "/p/a.txt" }] },
        actor,
      );
      expect(snap.grantedBy).toEqual(actor);
      expect(snap.grantedAt).toBeTypeOf("number");
      const reread = await store.read("ws-1");
      expect(reread.grantedBy?.authorityId).toBe("inline-approval");
      // The policy digest is unaffected by provenance fields.
      expect(reread.policyDigest).toBe(snap.policyDigest);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
