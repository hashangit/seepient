import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PolicyEngine } from "../policy-engine.js";
import { buildActionLifecycle } from "../action-lifecycle-factory.js";
import { InMemoryPolicyStore, InMemoryAuditStore, InMemoryCapabilityLedger } from "../in-memory-stores.js";
import { GlobalLifetimeForbiddenError } from "../../../foundations/errors.js";
import type {
  PermissionDecision,
  PermissionRequest,
  PolicyContext,
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

function fakeBoundary(result: { output: string; success: boolean }): ExecutionBoundary {
  return {
    capabilities: LOCAL_BACKEND,
    async execute(action) {
      return {
        state: "succeeded",
        result,
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

describe("Approval Lifetimes Gate (FR-005, FR-015, T006, T028)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "lifetimes-gate-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("T028 [US7]: multi mode never offers 'global' in approval options (offered-lifetimes truth)", async () => {
    const engine = new PolicyEngine("test-digest");

    const targetFile = join(tempDir, "test.txt");
    const action: PreparedToolAction = {
      version: 1,
      actionId: "act-1",
      runId: "r-multi",
      toolCallId: "c-1",
      toolName: "read_file",
      principalId: "tenant-a",
      argsDigest: "args-dig-1",
      actionDigest: "sha256-test-act",
      risk: "safe",
      display: {
        title: "read",
        summary: targetFile,
        canonicalTargets: [targetFile],
        effects: ["filesystem-read"],
      },
      effects: [{ kind: "filesystem-read", targets: [{ canonicalPath: targetFile, canonicalParent: tempDir, basename: "test.txt", exists: true, finalSymlink: false }], sensitivity: "normal" }],
      operation: {
        kind: "read-file",
        target: {
          canonicalPath: targetFile,
          canonicalParent: tempDir,
          basename: "test.txt",
          exists: true,
          finalSymlink: false,
        },
        expected: { exists: true },
      },
    };

    const multiWired = await buildActionLifecycle({
      principalId: "tenant-a",
      tenancyMode: "multi",
      runId: "r-multi",
      sessionId: "s-multi",
      workspaceRoot: tempDir,
      approvalBroker: { mode: "inline", request: async () => ({} as any) },
      executionBoundary: fakeBoundary({ output: "ok", success: true }),
      auditStore: new InMemoryAuditStore(),
      capabilityLedger: new InMemoryCapabilityLedger(),
      policyStore: new InMemoryPolicyStore(),
    });

    const multiResult = engine.evaluate(action, multiWired.policyContext);
    expect(multiResult.decision).toBe("needs-approval");

    if (multiResult.decision === "needs-approval") {
      const offeredLifetimes = multiResult.request.offeredLifetimes;
      // RED GATE ASSERTION: multi mode must NOT offer global!
      expect(offeredLifetimes).not.toContain("global");

      const choices = multiResult.request.approvalChoices ?? [];
      const choiceLifetimes = choices.map((c) => c.lifetime);
      expect(choiceLifetimes).not.toContain("global");

      const options = multiResult.request.approvalOptions ?? [];
      for (const opt of options) {
        expect(opt.supportedLifetimes).not.toContain("global");
      }
    }

    // Single mode: global should still be offered
    const singleWired = await buildActionLifecycle({
      principalId: "sdk-user",
      tenancyMode: "single",
      approvalMode: "manual",
      runId: "r-single",
      sessionId: "s-single",
      workspaceRoot: tempDir,
      approvalBroker: { mode: "inline", request: async () => ({} as any) },
      executionBoundary: fakeBoundary({ output: "ok", success: true }),
      auditStore: new InMemoryAuditStore(),
      capabilityLedger: new InMemoryCapabilityLedger(),
      policyStore: new InMemoryPolicyStore(),
    });

    singleWired.policyContext.activeCapabilities = { version: 1, capabilities: [] };
    const singleResult = engine.evaluate(action, singleWired.policyContext);
    expect(singleResult.decision).toBe("needs-approval");
    if (singleResult.decision === "needs-approval") {
      expect(singleResult.request.offeredLifetimes).toContain("global");
      const singleChoiceLifetimes = (singleResult.request.approvalChoices ?? []).map((c) => c.lifetime);
      expect(singleChoiceLifetimes).toContain("global");
    }
  });

  it("T006 [US0]: direct persistent approval with 'global' in multi mode throws GlobalLifetimeForbiddenError", async () => {
    let globalAuditStore = new InMemoryAuditStore();
    const targetFile = join(tempDir, "out.txt");
    const action: PreparedToolAction = {
      version: 1,
      actionId: "act-global-test",
      runId: "r-persist",
      toolCallId: "c-persist",
      toolName: "read_file",
      principalId: "tenant-a",
      argsDigest: "args-dig-persist",
      actionDigest: "sha256-test-act",
      risk: "safe",
      display: {
        title: "read",
        summary: targetFile,
        canonicalTargets: [targetFile],
        effects: ["filesystem-read"],
      },
      effects: [{ kind: "filesystem-read", targets: [{ canonicalPath: targetFile, canonicalParent: tempDir, basename: "out.txt", exists: true, finalSymlink: false }], sensitivity: "normal" }],
      operation: {
        kind: "read-file",
        target: {
          canonicalPath: targetFile,
          canonicalParent: tempDir,
          basename: "out.txt",
          exists: true,
          finalSymlink: false,
        },
        expected: { exists: true },
      },
    };

    const wired = await buildActionLifecycle({
      principalId: "tenant-a",
      tenancyMode: "multi",
      runId: "r-persist",
      sessionId: "s-persist",
      workspaceRoot: tempDir,
      approvalBroker: {
        mode: "inline",
        request: async (req: PermissionRequest): Promise<PermissionDecision> => ({
          approved: true,
          requestId: req.requestId,
          actionDigest: req.actionDigest,
          optionId: req.approvalOptions[0]?.optionId ?? "opt-1",
          lifetime: "global",
          actorId: "tenant-a",
          decidedAt: Date.now(),
        }),
      },
      executionBoundary: fakeBoundary({ output: "ok", success: true }),
      auditStore: (globalAuditStore = new InMemoryAuditStore()),
      capabilityLedger: new InMemoryCapabilityLedger(),
      policyStore: new InMemoryPolicyStore(),
    });

    // Running an action whose approval selects 'global' in multi mode must throw GlobalLifetimeForbiddenError
    await expect(wired.lifecycle.run(action)).rejects.toThrow(GlobalLifetimeForbiddenError);

    // R3 P2-11 pin: the backstop records a terminal denial before throwing —
    // the audit trail must not end at awaiting-approval.
    const terminal = await globalAuditStore.getTerminal(action.actionId);
    expect(terminal).toBeDefined();
    expect(terminal?.state).toBe("denied");
    expect(terminal?.reason).toBe("global-lifetime-forbidden");
  });
});
