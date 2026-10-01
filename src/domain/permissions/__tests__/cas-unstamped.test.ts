import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildActionLifecycle } from "../action-lifecycle-factory.js";
import { InMemoryPolicyStore, InMemoryCapabilityLedger } from "../in-memory-stores.js";
import { LocalAuditStore } from "../audit-recorder.js";
import type {
  PermissionDecision,
  PermissionRequest,
  Capability,
} from "../../../foundations/contracts/permission-policy.js";
import type { PreparedToolAction } from "../../../foundations/contracts/prepared-action.js";
import type { ExecutionBackendCapabilities, ExecutionBoundary } from "../../../foundations/contracts/execution-boundary.js";

const LOCAL_BACKEND: ExecutionBackendCapabilities = {
  backend: "local-native",
  capabilityKinds: ["commit-file", "read-file", "process", "model-egress"],
  exactCommit: true,
  hostFilteredEgress: true,
  environmentIsolation: true,
  supportedOperationKinds: ["none", "read-file", "commit-files", "process"],
};

function fakeBoundary(): ExecutionBoundary {
  return {
    capabilities: LOCAL_BACKEND,
    async execute(action) {
      return {
        state: "succeeded",
        result: { output: "ok", success: true },
        evidence: {
          backend: "local-native",
          actionDigest: action.actionDigest,
          executorId: "e",
          operationKind: action.operation.kind,
        },
      };
    },
  };
}

import { computeWorkspaceId } from "../policy-store.js";

describe("CAS Unstamped One-Bucket Semantics (FR-016, T029)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "cas-unstamped-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("T029 [US7]: unstamped capability appears exactly once after K sequential persistent approvals (no 2^K growth)", async () => {
    const policyStore = new InMemoryPolicyStore();
    const auditStore = new LocalAuditStore({ root: join(tempDir, "audit") });
    const ledger = new InMemoryCapabilityLedger();
    const workspaceId = computeWorkspaceId(tempDir);

    // Seed the policy store with one unstamped capability (legacy/operator grant without principalId)
    const unstampedCap: Capability = {
      kind: "read-root",
      root: tempDir,
      // No principalId!
    };

    await policyStore.compareAndSet(
      workspaceId,
      0,
      {
        version: 1,
        capabilities: [unstampedCap],
      },
      { kind: "human", authorityId: "seed", authenticatedBy: "test" },
    );

    // Run K=4 sequential persistent approvals by one principal (e.g. sdk-user)
    const K = 4;
    for (let i = 0; i < K; i++) {
      const targetFile = join(tempDir, `file-${i}.txt`);
      const action: PreparedToolAction = {
        version: 1,
        actionId: `act-step-${i}`,
        runId: `r-${i}`,
        toolCallId: `c-${i}`,
        toolName: "commit-file",
        principalId: "sdk-user",
        argsDigest: `args-dig-${i}`,
        actionDigest: `sha256-act-${i}`,
        risk: "safe",
        display: {
          title: "commit",
          summary: targetFile,
          canonicalTargets: [targetFile],
          effects: ["filesystem-write"],
        },
        effects: [{ kind: "filesystem-write", targets: [{ target: { canonicalPath: targetFile, canonicalParent: tempDir, basename: `file-${i}.txt`, exists: false, finalSymlink: false }, mode: "create" }] }],
        operation: {
          kind: "commit-files",
          commits: [{
            destination: { canonicalPath: targetFile, canonicalParent: tempDir, basename: `file-${i}.txt`, exists: false, finalSymlink: false },
            content: { artifactId: `art-${i}`, sha256: `hash-${i}`, byteLength: 10, mediaType: "text/plain" },
          }],
        },
      };

      const wired = await buildActionLifecycle({
        principalId: "sdk-user",
        tenancyMode: "single",
        runId: `r-${i}`,
        sessionId: `s-${i}`,
        workspaceRoot: tempDir,
        approvalBroker: {
          mode: "inline",
          request: async (req: PermissionRequest): Promise<PermissionDecision> => ({
            approved: true,
            requestId: req.requestId,
            actionDigest: req.actionDigest,
            optionId: req.approvalOptions[0]?.optionId ?? "opt-1",
            lifetime: "project",
            actorId: "sdk-user",
            decidedAt: Date.now(),
          }),
        },
        executionBoundary: fakeBoundary(),
        auditStore,
        capabilityLedger: ledger,
        policyStore,
      });

      const res = await wired.lifecycle.run(action);
      expect(res.outcome.state).toBe("succeeded");
    }

    // Read raw policy snapshot from store
    const snap = await policyStore.read(workspaceId);
    const unstampedInPolicy = snap.policy.capabilities.filter(
      (c) => c.kind === "read-root" && !c.principalId,
    );

    // RED GATE ASSERTION:
    // On the unfixed tree, unstampedInPolicy.length is 2^K = 16!
    // With one-bucket semantics, it must be exactly 1!
    expect(unstampedInPolicy.length).toBe(1);
  });

  it("T029b [US7]: unstamped capabilities are not erased in multi mode CAS merge", async () => {
    const policyStore = new InMemoryPolicyStore();
    const auditStore = new LocalAuditStore({ root: join(tempDir, "audit-multi") });
    const ledger = new InMemoryCapabilityLedger();
    const workspaceId = computeWorkspaceId(tempDir);

    // Seed the policy store with one unstamped capability
    const unstampedCap: Capability = {
      kind: "read-root",
      root: tempDir,
    };

    await policyStore.compareAndSet(
      workspaceId,
      0,
      {
        version: 1,
        capabilities: [unstampedCap],
      },
      { kind: "human", authorityId: "seed", authenticatedBy: "test" },
    );

    const targetFile = join(tempDir, "multi-file.txt");
    const action: PreparedToolAction = {
      version: 1,
      actionId: "act-multi-1",
      runId: "r-multi",
      toolCallId: "c-multi",
      toolName: "commit-file",
      principalId: "tenant-x",
      argsDigest: "args-dig-multi",
      actionDigest: "sha256-multi-1",
      risk: "safe",
      display: {
        title: "commit",
        summary: targetFile,
        canonicalTargets: [targetFile],
        effects: ["filesystem-write"],
      },
      effects: [{ kind: "filesystem-write", targets: [{ target: { canonicalPath: targetFile, canonicalParent: tempDir, basename: "multi-file.txt", exists: false, finalSymlink: false }, mode: "create" }] }],
      operation: {
        kind: "commit-files",
        commits: [{
          destination: { canonicalPath: targetFile, canonicalParent: tempDir, basename: "multi-file.txt", exists: false, finalSymlink: false },
          content: { artifactId: "art-m", sha256: "hash-m", byteLength: 10, mediaType: "text/plain" },
        }],
      },
    };

    const wired = await buildActionLifecycle({
      principalId: "tenant-x",
      tenancyMode: "multi",
      runId: "r-multi",
      sessionId: "s-multi",
      workspaceRoot: tempDir,
      approvalBroker: {
        mode: "inline",
        request: async (req: PermissionRequest): Promise<PermissionDecision> => ({
          approved: true,
          requestId: req.requestId,
          actionDigest: req.actionDigest,
          optionId: req.approvalOptions[0]?.optionId ?? "opt-1",
          lifetime: "project",
          actorId: "tenant-x",
          decidedAt: Date.now(),
        }),
      },
      executionBoundary: fakeBoundary(),
      auditStore,
      capabilityLedger: ledger,
      policyStore,
    });

    const res = await wired.lifecycle.run(action);
    expect(res.outcome.state).toBe("succeeded");

    const snap = await policyStore.read(workspaceId);
    const unstampedInPolicy = snap.policy.capabilities.filter(
      (c) => c.kind === "read-root" && !c.principalId,
    );

    // Multi mode must NOT silently erase the unstamped baseline capability
    expect(unstampedInPolicy.length).toBe(1);
  });
});
