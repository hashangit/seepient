/**
 * DurableApprovalStore merge-direction pins (022-5-WO4 T014/T017 + pass-15).
 *
 * The WO4 merge shipped inverted (disk unconditionally overwrote live —
 * the pass-13 P2-5 decision wipe survived with an opposite comment), and the
 * deterministic pin that would have caught it was never written. These pins
 * hold the merge contract in both directions:
 *   1. a live casSync decision survives a load() racing the floating
 *      persist() (stale disk must not wipe or resurrect);
 *   2. a genuinely newer cross-process decision on disk still loads;
 *   3. casSync rejects a decision whose requestId does not match the record.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;

function mkReq(requestId: string, principalId?: string) {
  return {
    requestId,
    principalId,
    runId: "r",
    toolCallId: "c",
    actionDigest: "ad",
    action: { title: "t", summary: "s", canonicalTargets: [], effects: [] },
    requestedCapabilities: [],
    approvalOptions: [],
    approvalChoices: [],
    offeredLifetimes: ["action"],
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  } as never;
}

function mkDecision(requestId: string, actorId?: string, approved = true) {
  return {
    approved,
    requestId,
    actionDigest: "ad",
    optionId: "opt",
    lifetime: "action" as const,
    actorId,
    decidedAt: Date.now(),
  } as never;
}

describe("DurableApprovalStore merge-preserving load() (WO4 T014 + pass-15)", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "seepient-approval-merge-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("a live casSync decision survives a load() racing the floating persist()", async () => {
    const { DurableApprovalStore } = await import("../durable-approval-store.js");
    const store = new DurableApprovalStore({ root: dir });
    await store.load();
    store.create({ request: mkReq("req-race", "tenant-a"), tenantId: "t", sessionId: "s", continuationId: "cont-race" });
    // Warm the disk file with the PENDING-only state (the steady state of a
    // running server) — the floating persist() from create() has landed.
    await store.saveRequest(mkReq("req-race", "tenant-a"));

    // The decision: casSync writes it live synchronously; its own persist()
    // floats. A getDecision on a disk-backed store re-reads the file HERE —
    // pre-fix (disk-wins merge) the stale pending-only snapshot wiped the
    // live decision and the read missed the decided approval.
    const cas = store.casSync("cont-race", 1, mkDecision("req-race", "tenant-a"));
    expect(cas.status).toBe("transitioned");

    await store.load(); // the racing read, deliberately before any persist lands

    expect(await store.getDecision("req-race")).toBeDefined();
    // No resurrection either: the decided pending-record must stay decided.
    expect(store.get("cont-race")?.status).toBe("approved");
    // And a second racing load must not flip anything.
    await store.load();
    expect(store.get("cont-race")?.status).toBe("approved");
  });

  it("a genuinely newer cross-process decision on disk still loads over a stale live entry", async () => {
    const { DurableApprovalStore } = await import("../durable-approval-store.js");
    const store = new DurableApprovalStore({ root: dir });
    await store.load();
    store.create({ request: mkReq("req-xp", "tenant-a"), tenantId: "t", sessionId: "s", continuationId: "cont-xp" });
    await store.saveRequest(mkReq("req-xp", "tenant-a"));
    // Live entry is request-only (updatedAt = now). Another process decides
    // and persists with a NEWER updatedAt — simulate by hand-writing the line.
    const file = join(dir, "store.ndjson");
    const newer = {
      kind: "request",
      request: mkReq("req-xp", "tenant-a"),
      decision: mkDecision("req-xp", "tenant-a"),
      createdAt: Date.now(),
      updatedAt: Date.now() + 10_000,
    };
    writeFileSync(file, JSON.stringify(newer) + "\n", "utf8");
    await store.load();
    // The merge must not be live-wins-ALWAYS: a newer disk decision loads.
    expect(await store.getDecision("req-xp")).toBeDefined();
    // The read afterwards re-merges the same newer line — still decided.
    expect(await store.getDecision("req-xp")).toBeDefined();
    expect(readFileSync(file, "utf8")).toContain("req-xp");
  });

  it("casSync rejects a decision whose requestId does not match the record (WO4 T016 pin)", async () => {
    const { DurableApprovalStore } = await import("../durable-approval-store.js");
    const store = new DurableApprovalStore({ root: dir, inMemory: true });
    store.create({ request: mkReq("req-own", "tenant-a"), tenantId: "t", sessionId: "s", continuationId: "cont-own" });
    const cas = store.casSync("cont-own", 1, mkDecision("req-FOREIGN", "tenant-a"));
    expect(cas.status).toBe("stale");
    expect(store.get("cont-own")?.status).toBe("pending");
    // The foreign decision must not have been planted under its own key.
    expect(await store.getDecision("req-FOREIGN")).toBeUndefined();
  });
});
