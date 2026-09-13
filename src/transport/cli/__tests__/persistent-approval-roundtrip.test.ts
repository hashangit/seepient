/**
 * T044 / T058: SINGLE-MODE-ROUNDTRIP gate (FR-030)
 *
 * Verifies that in CLI-root single mode:
 * 1. An action requiring approval is approved with lifetime "project".
 * 2. The lifecycle rebuilds from the stored policy store (fresh instance, same workspace & principal).
 * 3. The subsequent execution of the same action is covered by stored policy without re-prompting.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildActionLifecycle } from "../../../domain/permissions/action-lifecycle-factory.js";
import { LocalPolicyStore } from "../../../domain/permissions/policy-store.js";
import { LocalAuditStore } from "../../../domain/permissions/audit-recorder.js";
import { PersistedCapabilityLedger } from "../../../domain/permissions/persisted-capability-ledger.js";
import type { PreparedToolAction } from "../../../foundations/contracts/prepared-action.js";

describe("T044 / T058: SINGLE-MODE-ROUNDTRIP Gate (FR-030)", () => {
  let dir: string;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "cli-roundtrip-")));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeAction(actionId: string, actionDigest: string, workspaceRoot: string): PreparedToolAction {
    return {
      version: 1,
      actionId,
      runId: "run-roundtrip-1",
      toolCallId: "call-1",
      toolName: "execute_shell_command",
      principalId: "cli-user",
      argsDigest: "args-digest",
      actionDigest,
      risk: "destructive",
      effects: [
        {
          kind: "process-exec",
          command: { executable: "/usr/bin/git", argv: ["status"], cwd: workspaceRoot },
          requestedRoots: [{ access: "read", canonicalRoot: workspaceRoot }],
        },
      ],
      display: {
        title: "run git status",
        summary: "git status",
        canonicalTargets: [],
        effects: ["process-exec"],
      },
      operation: {
        kind: "process",
        command: { executable: "/usr/bin/git", argv: ["status"], cwd: workspaceRoot },
        roots: [{ access: "read", canonicalRoot: workspaceRoot }],
      },
    };
  }

  it("project approval in first lifecycle covers the action in a rebuilt second lifecycle", async () => {
    const policyStore = new LocalPolicyStore({ root: join(dir, "policy") });
    const auditStore = new LocalAuditStore({ root: join(dir, "audit") });
    const capabilityLedger = new PersistedCapabilityLedger({ root: join(dir, "ledger") });
    const workspaceRoot = dir;

    const executionBoundary = {
      capabilities: {
        backend: "local-native",
        capabilityKinds: ["read-root", "write-root", "process", "model-egress"],
        exactCommit: true,
        hostFilteredEgress: true,
        environmentIsolation: true,
        supportedOperationKinds: ["read-file", "commit-files", "process"],
      },
      execute: async (_action: any) => ({
        state: "succeeded" as const,
        result: { output: "git status clean", success: true },
        evidence: {
          backend: "local-native",
          actionDigest: _action.actionDigest,
        },
      }),
    };

    // Broker for instance 1: approves with lifetime: "project"
    const broker1 = {
      mode: "inline" as const,
      request: vi.fn().mockImplementation(async (request: any) => {
        return {
          approved: true,
          requestId: request.requestId,
          actionDigest: request.actionDigest,
          optionId: request.approvalOptions?.[0]?.optionId ?? "opt-1",
          lifetime: "project" as const,
          actorId: "cli-operator",
          decidedAt: Date.now(),
        };
      }),
    };

    // 1. Build first lifecycle
    const wired1 = await buildActionLifecycle({
      runId: "run-roundtrip-1",
      workspaceRoot,
      principalId: "cli-user",
      tenancyMode: "single",
      approvalMode: "manual",
      policyStore,
      auditStore,
      capabilityLedger,
      approvalBroker: broker1 as any,
      executionBoundary: executionBoundary as any,
    });

    const action1 = makeAction("action-1", "digest-git-status", workspaceRoot);
    const result1 = await wired1.lifecycle.run(action1);

    if (result1.outcome.state !== "succeeded") {
      console.log("Result1 denial:", result1.outcome.denial, result1.toolResult?.output, result1.decision);
    }
    expect(result1.outcome.state).toBe("succeeded");
    expect(broker1.request).toHaveBeenCalledTimes(1);

    // 2. Build second lifecycle (rebuild fresh instance on same workspace)
    // Broker for instance 2: should NEVER be called because action is already covered!
    const broker2 = {
      mode: "inline" as const,
      request: vi.fn().mockImplementation(async () => {
        throw new Error("Broker 2 was called! The action should have been covered by stored policy without re-prompting.");
      }),
    };

    const wired2 = await buildActionLifecycle({
      runId: "run-roundtrip-2",
      workspaceRoot,
      principalId: "cli-user",
      tenancyMode: "single",
      approvalMode: "manual",
      policyStore,
      auditStore,
      capabilityLedger,
      approvalBroker: broker2 as any,
      executionBoundary: executionBoundary as any,
    });

    const action2 = makeAction("action-2", "digest-git-status", workspaceRoot);
    const result2 = await wired2.lifecycle.run(action2);

    expect(result2.outcome.state).toBe("succeeded");
    expect(broker2.request).not.toHaveBeenCalled();
  });
});
