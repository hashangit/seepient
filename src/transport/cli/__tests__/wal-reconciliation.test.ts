/**
 * WAL recovery survives ADMINISTRATIVE policy mutations (round 8 P0).
 *
 * The append-only mutation history is STORE-OWNED metadata: administrative
 * compare-and-sets (approve / revoke-cap / revoke-global) rebuild the
 * CapabilitySet with only version + capabilities, so they must preserve —
 * never erase — the evidence needed to finalize an unresolved inline grant
 * after a restart. These tests drive the REAL CLI Agent admin methods
 * (approvePolicyProposal / revokePolicyCapability /
 * revokeGlobalPolicyCapability) against a real LocalPolicyStore.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../agent.js";
import type {
  ExecutionBoundary,
  ExecutionResult,
  ExecutionBackendCapabilities,
} from "../../../foundations/contracts/execution-boundary.js";
import type { PreparedToolAction } from "../../../foundations/contracts/prepared-action.js";
import type { CapabilityEnvelope } from "../../../foundations/contracts/permission-policy.js";
import type { ToolResult } from "../../../foundations/types.js";
import {
  LocalAuditStore,
} from "../../../domain/permissions/audit-recorder.js";
import {
  LocalPolicyStore,
  GLOBAL_WORKSPACE_ID,
} from "../../../domain/permissions/policy-store.js";
import { buildActionLifecycle } from "../../../domain/permissions/action-lifecycle-factory.js";
import { createMockRuntime } from "../../../domain/__tests__/test-doubles.js";

function mockRuntime(): any {
  return createMockRuntime([{ content: "ok" }]);
}

const LOCAL_BACKEND: ExecutionBackendCapabilities = {
  backend: "local-native",
  capabilityKinds: ["commit-file", "read-file", "process", "model-egress"],
  exactCommit: true,
  hostFilteredEgress: true,
  environmentIsolation: true,
  supportedOperationKinds: ["none", "read-file", "commit-files", "process"],
};

function fakeBoundary(result: ToolResult): ExecutionBoundary {
  return {
    capabilities: LOCAL_BACKEND,
    async execute(
      _action: PreparedToolAction,
      _env: CapabilityEnvelope,
    ): Promise<ExecutionResult> {
      return {
        state: "succeeded",
        result,
        evidence: {
          backend: "local-native",
          actionDigest: _action.actionDigest,
          executorId: "test",
          operationKind: _action.operation.kind,
        },
      };
    },
  };
}

describe("administrative mutations preserve WAL history (round 8 P0)", () => {
  const cap = { kind: "commit-file" as const, path: "/p/a.txt" };
  const actor = { kind: "human" as const, authorityId: "inline-approval", authenticatedBy: "tui" };

  async function unresolvedGrant(
    audit: LocalAuditStore,
    store: LocalPolicyStore,
    actionId: string,
    mutationId: string,
  ): Promise<void> {
    await store.compareAndSet("ws-1", 0, { version: 1, capabilities: [cap] }, actor, { mutationId });
    await audit.append(
      {
        eventId: `intent-${actionId}`,
        actionId,
        actionDigest: `d-${actionId}`,
        principalId: "user-A",
        runId: "r1",
        state: "policy-grant-intent",
        timestamp: 1,
        policyDigest: "digest",
        optionId: "opt-1",
        lifetime: "project",
        capabilities: [cap],
        actorId: "user-A",
        policyBeforeVersion: 0,
        grantedWorkspaceId: "ws-1",
        mutationId,
      },
      { idempotencyKey: `${actionId}:policy-grant-intent` },
    );
  }

  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wal-admin-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function restart(audit: LocalAuditStore, store: LocalPolicyStore): Promise<void> {
    await buildActionLifecycle({
      principalId: "user-A",
      runId: "r1",
      sessionId: "s1",
      workspaceRoot: dir,
      approvalBroker: { mode: "none" as const, request: async () => ({ approved: false, requestId: "x", actionDigest: "y", actorId: "u", decidedAt: 0 }) },
      executionBoundary: fakeBoundary({ output: "ok", success: true }),
      auditStore: audit,
      policyStore: store,
    });
  }

  it("unresolved inline grant -> ADMIN APPROVE (adds a capability) -> restart -> original grant finalized", async () => {
    const audit = new LocalAuditStore({ root: dir });
    const store = new LocalPolicyStore({ root: join(dir, "policy") });
    await unresolvedGrant(audit, store, "action-A", "mut-A");
    // The exact administrative flow from src/transport/cli/agent.ts:
    // approvePolicyProposal builds `{ version: 1, capabilities }` ONLY.
    const agent = new Agent(mockRuntime(), "gpt-test", {}, "sys");
    agent.setPolicyStore(store, "ws-1");
    await agent.stagePolicyProposal({ kind: "commit-file", path: "/p/b.txt" });
    const proposal = agent.listPolicyProposals()[0];
    const afterApprove = await agent.approvePolicyProposal(proposal.id);
    expect(afterApprove.policy.capabilities).toHaveLength(2);
    // The store itself preserved the grant's evidence across the admin CAS:
    // the append-only history survives; the latest-marker slot is cleared
    // (the admin mutation carries no transaction ID) — the HISTORY is what
    // proves the grant, which is the round-8 guarantee.
    const snap = await store.read("ws-1");
    expect(snap.mutationHistory).toEqual([{ mutationId: "mut-A", version: 1 }]);
    expect(snap.mutationId).toBeUndefined();
    await restart(audit, store);
    const committed = (await audit.listEvents()).filter((e) => e.state === "policy-granted" && e.actionId === "action-A");
    expect(committed).toHaveLength(1);
    expect(committed[0].mutationId).toBe("mut-A");
  });

  it("unresolved inline grant -> ADMIN REVOKE-CAP (removes a capability) -> restart -> original grant finalized", async () => {
    const audit = new LocalAuditStore({ root: dir });
    const store = new LocalPolicyStore({ root: join(dir, "policy") });
    await unresolvedGrant(audit, store, "action-A", "mut-A");
    const agent = new Agent(mockRuntime(), "gpt-test", {}, "sys");
    agent.setPolicyStore(store, "ws-1");
    const before = await store.read("ws-1");
    const afterRevoke = await agent.revokePolicyCapability(before.policy.capabilities[0], before.version);
    expect(afterRevoke.version).toBe(before.version + 1);
    const snap = await store.read("ws-1");
    expect(snap.mutationHistory).toEqual([{ mutationId: "mut-A", version: 1 }]);
    await restart(audit, store);
    const committed = (await audit.listEvents()).filter((e) => e.state === "policy-granted" && e.actionId === "action-A");
    expect(committed).toHaveLength(1);
    expect(committed[0].mutationId).toBe("mut-A");
  });

  it("unresolved inline grant -> ADMIN REVOKE-GLOBAL -> restart -> original grant finalized", async () => {
    const audit = new LocalAuditStore({ root: dir });
    const store = new LocalPolicyStore({ root: join(dir, "policy") });
    // The grant lives in the GLOBAL workspace; revoke-global mutates it.
    await store.compareAndSet(GLOBAL_WORKSPACE_ID, 0, { version: 1, capabilities: [cap] }, actor, { mutationId: "mut-A" });
    await audit.append(
      {
        eventId: "intent-A",
        actionId: "action-A",
        actionDigest: "d-A",
        principalId: "user-A",
        runId: "r1",
        state: "policy-grant-intent",
        timestamp: 1,
        policyDigest: "digest",
        optionId: "opt-1",
        lifetime: "global",
        capabilities: [cap],
        actorId: "user-A",
        policyBeforeVersion: 0,
        grantedWorkspaceId: GLOBAL_WORKSPACE_ID,
        mutationId: "mut-A",
      },
      { idempotencyKey: "action-A:policy-grant-intent" },
    );
    const agent = new Agent(mockRuntime(), "gpt-test", {}, "sys");
    agent.setPolicyStore(store, "ws-1");
    const globalBefore = await store.read(GLOBAL_WORKSPACE_ID);
    await agent.revokeGlobalPolicyCapability(globalBefore.policy.capabilities[0], globalBefore.version);
    const snap = await store.read(GLOBAL_WORKSPACE_ID);
    expect(snap.mutationHistory).toEqual([{ mutationId: "mut-A", version: 1 }]);
    await restart(audit, store);
    const committed = (await audit.listEvents()).filter((e) => e.state === "policy-granted" && e.actionId === "action-A");
    expect(committed).toHaveLength(1);
    expect(committed[0].mutationId).toBe("mut-A");
  });

  it("revoke with a stale listed version is rejected and removes nothing (review round 9)", async () => {
    const audit = new LocalAuditStore({ root: dir });
    const store = new LocalPolicyStore({ root: join(dir, "policy") });
    await store.compareAndSet("ws-1", 0, { version: 1, capabilities: [cap] }, actor, { mutationId: "mut-A" });
    // The policy moved after the operator saw the list: cap is still there,
    // but at version 2 with an extra entry.
    await store.compareAndSet(
      "ws-1",
      1,
      { version: 1, capabilities: [cap, { kind: "commit-file", path: "/p/b.txt" }] },
      actor,
    );
    const agent = new Agent(mockRuntime(), "gpt-test", {}, "sys");
    agent.setPolicyStore(store, "ws-1");
    await expect(
      agent.revokePolicyCapability(cap, 1),
    ).rejects.toThrow(/changed since it was listed/);
    const snap = await store.read("ws-1");
    expect(snap.policy.capabilities).toHaveLength(2);
  });
});
