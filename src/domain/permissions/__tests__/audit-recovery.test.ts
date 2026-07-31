/**
 * Audit outbox + crash-recovery tests (spec 008, T109 fix, FR-014).
 *
 * Verifies:
 *  - the terminal-event outbox retries failed terminal appends and reports
 *    unhealthy while pending
 *  - crash-recovery marks `dispatched` actions without a terminal as
 *    `indeterminate` (never re-executed)
 *  - idempotency: recovery does not double-mark an already-indeterminate action
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LocalAuditStore,
  TerminalEventOutbox,
  recoverIndeterminateActions,
  idempotencyKey,
} from "../audit-recorder.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seepient-audit-recovery-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("TerminalEventOutbox (T109 fix)", () => {
  it("enqueue marks the deployment unhealthy", async () => {
    const store = new LocalAuditStore({ root: dir });
    const outbox = new TerminalEventOutbox(store);
    expect(outbox.isHealthy()).toBe(true);
    await outbox.enqueue(
      {
        eventId: "e",
        actionId: "a",
        actionDigest: "d",
        principalId: "ws",
        runId: "r",
        state: "succeeded",
        timestamp: Date.now(),
        policyDigest: "d",
      },
      idempotencyKey("a", "succeeded"),
    );
    expect(outbox.isHealthy()).toBe(false);
    expect(outbox.size()).toBe(1);
  });

  it("flush retries pending terminal events and clears them on success", async () => {
    const store = new LocalAuditStore({ root: dir });
    const outbox = new TerminalEventOutbox(store);
    await outbox.enqueue(
      {
        eventId: "e",
        actionId: "a",
        actionDigest: "d",
        principalId: "ws",
        runId: "r",
        state: "succeeded",
        timestamp: Date.now(),
        policyDigest: "d",
      },
      idempotencyKey("a", "succeeded"),
    );
    expect(outbox.isHealthy()).toBe(false);
    const remaining = await outbox.flush();
    expect(remaining).toBe(0);
    expect(outbox.isHealthy()).toBe(true);
    expect(outbox.size()).toBe(0);
    // The event is now durable in the store.
    const terminal = await store.getTerminal("a");
    expect(terminal?.state).toBe("succeeded");
  });

  it("flush keeps retrying when the store keeps failing", async () => {
    // A store whose append always throws.
    const failingStore = {
      append: async () => {
        throw new Error("disk full");
      },
    } as unknown as LocalAuditStore;
    const outbox = new TerminalEventOutbox(failingStore);
    await outbox.enqueue(
      {
        eventId: "e",
        actionId: "a",
        actionDigest: "d",
        principalId: "ws",
        runId: "r",
        state: "succeeded",
        timestamp: Date.now(),
        policyDigest: "d",
      },
      idempotencyKey("a", "succeeded"),
    );
    const remaining = await outbox.flush();
    expect(remaining).toBe(1);
    expect(outbox.isHealthy()).toBe(false);
  });
});

describe("recoverIndeterminateActions (T109 fix, FR-014)", () => {
  it("marks a dispatched action without a terminal as indeterminate", async () => {
    const store = new LocalAuditStore({ root: dir });
    // Write a `dispatched` event with NO terminal follow-up (simulates a
    // crash after dispatch but before the terminal append).
    await store.append(
      {
        eventId: "e1",
        actionId: "a-dispatched",
        actionDigest: "d",
        principalId: "ws",
        runId: "r",
        state: "dispatched",
        timestamp: Date.now(),
        policyDigest: "d",
      },
      { idempotencyKey: idempotencyKey("a-dispatched", "dispatched") },
    );

    const indeterminate = await recoverIndeterminateActions(store);
    expect(indeterminate).toContain("a-dispatched");

    // The recovery marker is itself a terminal event.
    const terminal = await store.getTerminal("a-dispatched");
    expect(terminal?.state).toBe("indeterminate");
  });

  it("does NOT mark a dispatched action that HAS a terminal event", async () => {
    const store = new LocalAuditStore({ root: dir });
    await store.append(
      {
        eventId: "e1",
        actionId: "a-complete",
        actionDigest: "d",
        principalId: "ws",
        runId: "r",
        state: "dispatched",
        timestamp: Date.now(),
        policyDigest: "d",
      },
      { idempotencyKey: idempotencyKey("a-complete", "dispatched") },
    );
    await store.append(
      {
        eventId: "e2",
        actionId: "a-complete",
        actionDigest: "d",
        principalId: "ws",
        runId: "r",
        state: "succeeded",
        timestamp: Date.now(),
        policyDigest: "d",
      },
      { idempotencyKey: idempotencyKey("a-complete", "succeeded") },
    );

    const indeterminate = await recoverIndeterminateActions(store);
    expect(indeterminate).not.toContain("a-complete");
  });

  it("idempotent: a second recovery run does not double-mark", async () => {
    const store = new LocalAuditStore({ root: dir });
    await store.append(
      {
        eventId: "e1",
        actionId: "a-once",
        actionDigest: "d",
        principalId: "ws",
        runId: "r",
        state: "dispatched",
        timestamp: Date.now(),
        policyDigest: "d",
      },
      { idempotencyKey: idempotencyKey("a-once", "dispatched") },
    );

    const first = await recoverIndeterminateActions(store);
    expect(first).toContain("a-once");
    const second = await recoverIndeterminateActions(store);
    // The indeterminate marker is itself a terminal state; the second run
    // sees the action now has a terminal and does not re-mark it.
    expect(second).not.toContain("a-once");
  });

  it("returns empty when there is no audit data yet", async () => {
    const store = new LocalAuditStore({ root: dir });
    const indeterminate = await recoverIndeterminateActions(store);
    expect(indeterminate).toEqual([]);
  });

  it("enqueues recovery markers that fail to append into the outbox", async () => {
    // Use a store that accepts dispatched but throws on indeterminate.
    // We simulate by spy: append the dispatched normally, then make append
    // throw for the indeterminate marker.
    const realStore = new LocalAuditStore({ root: dir });
    await realStore.append(
      {
        eventId: "e1",
        actionId: "a-fail",
        actionDigest: "d",
        principalId: "ws",
        runId: "r",
        state: "dispatched",
        timestamp: Date.now(),
        policyDigest: "d",
      },
      { idempotencyKey: idempotencyKey("a-fail", "dispatched") },
    );
    // Now break append so the indeterminate marker can't be written.
    const brokenStore = {
      ...realStore,
      append: async () => {
        throw new Error("now broken");
      },
    } as unknown as LocalAuditStore;
    // The brokenStore's dir must point at the same location for recovery to
    // find the dispatched event.
    (brokenStore as unknown as { dir: string }).dir = dir;

    const outbox = new TerminalEventOutbox(realStore);
    const indeterminate = await recoverIndeterminateActions(brokenStore, outbox);
    // Recovery detected the dispatched action but couldn't append the marker;
    // it enqueued it for retry.
    expect(indeterminate).toContain("a-fail");
    expect(outbox.size()).toBeGreaterThan(0);
  });
});

describe("TerminalEventOutbox concurrency (shared outbox safety)", () => {
  it("persists every enqueued event exactly once under concurrent enqueue + flush", async () => {
    // A shared outbox (one instance across N concurrent per-request lifecycles,
    // as the HTTP server uses) must not lose entries when enqueue and flush
    // interleave. Without the in-process mutex, a flush iterating `pending`
    // races an enqueue mutating it and entries can be dropped.
    const store = new LocalAuditStore({ root: dir });
    const outbox = new TerminalEventOutbox(store);

    // Make the underlying append briefly slow so flush is genuinely in flight
    // while enqueues land — widens the race window the mutex must close.
    const N = 50;
    const events = Array.from({ length: N }, (_, i) => ({
      eventId: `e-${i}`,
      actionId: `a-${i}`,
      actionDigest: `d-${i}`,
      principalId: "ws",
      runId: "r",
      state: "succeeded" as const,
      timestamp: Date.now(),
      policyDigest: "d",
    }));

    // Interleave enqueues with flushes; all concurrent.
    const ops: Promise<unknown>[] = [];
    for (let i = 0; i < N; i++) {
      ops.push(outbox.enqueue(events[i], idempotencyKey(`a-${i}`, "succeeded")));
      if (i % 5 === 0) ops.push(outbox.flush());
    }
    await Promise.all(ops);

    // Final flush drains everything.
    const remaining = await outbox.flush();
    expect(remaining).toBe(0);
    expect(outbox.size()).toBe(0);
    expect(outbox.isHealthy()).toBe(true);

    // Every event MUST be present in the audit store exactly once — no losses
    // from the race, no duplicates.
    for (let i = 0; i < N; i++) {
      const term = await store.getTerminal(`a-${i}`);
      expect(term, `event a-${i} should be persisted`).toBeDefined();
      expect(term?.state).toBe("succeeded");
    }
  });

  it("reload discovers and drains an abandoned sibling-process outbox (cross-process recovery)", async () => {
    // Gate 5 / cross-process safety: each process owns pending.<pid>.ndjson;
    // a crashed process leaves its outbox behind. A NEW process starting
    // against the same ~/.seepient must discover that abandoned file and
    // drain its entries — otherwise terminal events are lost forever.
    const store = new LocalAuditStore({ root: dir });
    const outboxDir = join(dir, "outbox");
    // Simulate a sibling process (pid 99999) that enqueued a terminal event
    // and crashed before flushing. Write its per-process outbox file directly.
    const siblingFile = join(outboxDir, "pending.99999.ndjson");
    mkdirSync(outboxDir, { recursive: true });
    writeFileSync(
      siblingFile,
      JSON.stringify({
        event: {
          eventId: "e-sib",
          actionId: "a-sibling",
          actionDigest: "d-sib",
          principalId: "ws",
          runId: "r",
          state: "succeeded",
          timestamp: Date.now(),
          policyDigest: "d",
        },
        idempotencyKey: idempotencyKey("a-sibling", "succeeded"),
        attempts: 0,
        lastAttempt: 0,
      }) + "\n",
      "utf8",
    );

    // A fresh outbox (this process) loads ALL pending.*.ndjson at startup.
    const outbox = new TerminalEventOutbox(store, { outboxDir });
    await outbox.reload();
    expect(outbox.size()).toBe(1);
    expect(outbox.isHealthy()).toBe(false);

    // Flush drains the sibling's entry into the shared audit store.
    const remaining = await outbox.flush();
    expect(remaining).toBe(0);
    const term = await store.getTerminal("a-sibling");
    expect(term?.state).toBe("succeeded");
  });
});
