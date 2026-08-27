/**
 * Stored-policy reconciliation tests (spec 017, T010 / FR-019).
 *
 * Scenarios:
 *   1. Pre-fix snapshot gains newly-defaulted kinds on startup
 *   2. Explicit user grants in pre-fix snapshot remain untouched
 *   3. Post-widening revocation stays revoked (not resurrected)
 *   4. Corrupt store fails closed (empty principal policy)
 */
import { describe, it, expect, beforeEach } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { buildActionLifecycle } from "../action-lifecycle-factory.js";
import { LocalPolicyStore, computeWorkspaceId, CURRENT_CEILING_VERSION } from "../policy-store.js";
import { InMemoryArtifactStore } from "../../../capabilities/execution/in-memory-artifact-store.js";
import type { ApprovalBroker } from "../../../foundations/contracts/permission-policy.js";
import type { ExecutionBoundary } from "../../../foundations/contracts/execution-boundary.js";

const NOOP_BROKER: ApprovalBroker = {
  mode: "inline",
  request: async (req) => ({
    approved: false,
    requestId: req.requestId,
    actionDigest: req.actionDigest,
    actorId: "test-broker",
    reason: "cancelled",
    decidedAt: Date.now(),
  }),
};

const LOCAL_BOUNDARY: ExecutionBoundary = {
  capabilities: {
    backend: "local-native",
    capabilityKinds: [
      "read-root",
      "read-file",
      "write-root",
      "commit-file",
      "process",
      "model-egress",
      "network-destination",
      "external-recipient",
      "secret-ref",
    ],
    exactCommit: true,
    hostFilteredEgress: true,
    environmentIsolation: true,
    supportedOperationKinds: ["none", "read-file", "commit-files", "process", "broker"],
  },
  execute: async (action) => ({
    state: "succeeded",
    result: { output: "ok", success: true },
    evidence: {
      backend: "local-native",
      actionDigest: action.actionDigest,
      executorId: "test",
      operationKind: action.operation.kind,
    },
  }),
};

describe("stored-policy reconciliation (spec 017, T010 / FR-019)", () => {
  let tempDir: string;
  let workspaceRoot: string;
  let policyDir: string;
  let policyStore: LocalPolicyStore;
  let workspaceId: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "seepient-reconcile-"));
    workspaceRoot = path.join(tempDir, "workspace");
    policyDir = path.join(tempDir, "policies");
    await fs.mkdir(workspaceRoot, { recursive: true });
    await fs.mkdir(policyDir, { recursive: true });
    policyStore = new LocalPolicyStore({ root: policyDir });
    workspaceId = computeWorkspaceId(workspaceRoot);
  });

  it("seeds newly-defaulted kinds into a pre-fix snapshot (ceilingVersion < 2)", async () => {
    // Write pre-fix snapshot (v1 without ceilingVersion)
    await policyStore.compareAndSet(
      workspaceId,
      0,
      {
        version: 1,
        capabilities: [
          { kind: "read-root", root: workspaceRoot },
          { kind: "write-root", root: workspaceRoot },
          { kind: "process" },
          { kind: "model-egress", providerClass: "*", dataClasses: ["normal", "sensitive"] },
          { kind: "commit-file", path: path.join(workspaceRoot, "custom.txt") },
        ],
      },
      { kind: "human", authorityId: "user-1", authenticatedBy: "test" },
    );

    // Ensure ceilingVersion is undefined/absent as in real legacy snapshots
    const file = path.join(policyDir, `${workspaceId}.json`);
    const raw = JSON.parse(await fs.readFile(file, "utf8"));
    delete raw.ceilingVersion;
    await fs.writeFile(file, JSON.stringify(raw), "utf8");

    const wired = await buildActionLifecycle({
      principalId: "user-1",
      runId: "run-1",
      workspaceRoot,
      approvalBroker: NOOP_BROKER,
      executionBoundary: LOCAL_BOUNDARY,
      policyStore,
      auditRoot: path.join(tempDir, "audit"),
      artifacts: new InMemoryArtifactStore(),
    });

    const principal = wired.policyContext.principalPolicy.capabilities;
    // Must contain newly-defaulted kinds
    expect(principal.some((c) => c.kind === "network-destination" && (c as any).host === "*")).toBe(true);
    expect(principal.some((c) => c.kind === "external-recipient" && (c as any).service === "*")).toBe(true);
    expect(principal.some((c) => c.kind === "secret-ref" && (c as any).ref === "*")).toBe(true);
    // Explicit custom grant must be preserved
    expect(principal.some((c) => c.kind === "commit-file" && (c as any).path.endsWith("custom.txt"))).toBe(true);

    // Stored policy in policyStore must now be reconciled with ceilingVersion updated
    const updatedSnap = await policyStore.read(workspaceId);
    expect(updatedSnap.ceilingVersion).toBe(CURRENT_CEILING_VERSION);
    expect(updatedSnap.policy.capabilities.some((c) => c.kind === "network-destination")).toBe(true);
  });

  it("does not resurrect deliberate revocations in post-widening snapshots (ceilingVersion >= 2)", async () => {
    // Stored snapshot with ceilingVersion: CURRENT_CEILING_VERSION, where user revoked network-destination
    await policyStore.compareAndSet(
      workspaceId,
      0,
      {
        version: 1,
        capabilities: [
          { kind: "read-root", root: workspaceRoot },
          { kind: "write-root", root: workspaceRoot },
          { kind: "process" },
          { kind: "model-egress", providerClass: "*", dataClasses: ["normal", "sensitive"] },
          // network-destination is intentionally omitted
          { kind: "external-recipient", service: "*", recipient: "*" },
          { kind: "secret-ref", ref: "*" },
        ],
      },
      { kind: "human", authorityId: "user-1", authenticatedBy: "test" },
    );

    // Manually ensure ceilingVersion is set to CURRENT_CEILING_VERSION in the store
    const file = path.join(policyDir, `${workspaceId}.json`);
    const raw = JSON.parse(await fs.readFile(file, "utf8"));
    raw.ceilingVersion = CURRENT_CEILING_VERSION;
    await fs.writeFile(file, JSON.stringify(raw), "utf8");

    const wired = await buildActionLifecycle({
      principalId: "user-1",
      runId: "run-2",
      workspaceRoot,
      approvalBroker: NOOP_BROKER,
      executionBoundary: LOCAL_BOUNDARY,
      policyStore,
      auditRoot: path.join(tempDir, "audit"),
      artifacts: new InMemoryArtifactStore(),
    });

    const principal = wired.policyContext.principalPolicy.capabilities;
    // network-destination must STAY revoked
    expect(principal.some((c) => c.kind === "network-destination")).toBe(false);
    expect(principal.some((c) => c.kind === "external-recipient")).toBe(true);
  });

  it("fails closed on corrupted policy store", async () => {
    const file = path.join(policyDir, `${workspaceId}.json`);
    await fs.writeFile(file, "{ invalid json", "utf8");

    const wired = await buildActionLifecycle({
      principalId: "user-1",
      runId: "run-3",
      workspaceRoot,
      approvalBroker: NOOP_BROKER,
      executionBoundary: LOCAL_BOUNDARY,
      policyStore,
      auditRoot: path.join(tempDir, "audit"),
      artifacts: new InMemoryArtifactStore(),
    });

    expect(wired.policyContext.principalPolicy.capabilities).toHaveLength(0);
  });
});
