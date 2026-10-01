import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildActionLifecycle } from "../../../domain/permissions/action-lifecycle-factory.js";
import { LocalPolicyStore, computeWorkspaceId } from "../../../domain/permissions/policy-store.js";
import { LocalAuditStore } from "../../../domain/permissions/audit-recorder.js";
import { PersistedCapabilityLedger } from "../../../domain/permissions/persisted-capability-ledger.js";
import type { PreparedToolAction } from "../../../foundations/contracts/prepared-action.js";
import type { PermissionRequest, PermissionDecision } from "../../../foundations/contracts/permission-policy.js";

describe("T030 [US7] CLI->SDK Round-Trip Approval Visibility (FR-017)", () => {
  let dir: string;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "cli-sdk-roundtrip-")));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("an approval granted via CLI surface is visible to SDK surface in the same workspace", async () => {
    const policyStore = new LocalPolicyStore({ root: join(dir, "policy") });
    const audit = new LocalAuditStore({ root: join(dir, "audit") });
    const ledger = new PersistedCapabilityLedger({ root: join(dir, "ledger") });

    const targetFile = join(dir, "cli-created.txt");
    const cliAction: PreparedToolAction = {
      version: 1,
      actionId: "act-cli-1",
      runId: "r-cli",
      toolCallId: "c-1",
      toolName: "commit-file",
      principalId: "sdk-user",
      argsDigest: "d-1",
      actionDigest: "act-dig-1",
      risk: "safe",
      display: {
        title: "commit",
        summary: targetFile,
        canonicalTargets: [targetFile],
        effects: ["filesystem-write"],
      },
      effects: [
        {
          kind: "filesystem-write",
          targets: [{
            target: {
              canonicalPath: targetFile,
              canonicalParent: dir,
              basename: "cli-created.txt",
              exists: false,
              finalSymlink: false,
            },
            mode: "create",
          }],
        },
      ],
      operation: {
        kind: "commit-files",
        commits: [{
          destination: {
            canonicalPath: targetFile,
            canonicalParent: dir,
            basename: "cli-created.txt",
            exists: false,
            finalSymlink: false,
          },
          content: { artifactId: "art-1", sha256: "h1", byteLength: 5, mediaType: "text/plain" },
        }],
      },
    };

    // 1. Process 1 (CLI surface): Approves action with 'project' lifetime using unified sdk-user sentinel
    const cliLifecycle = await buildActionLifecycle({
      principalId: "sdk-user",
      tenancyMode: "single",
      runId: "r-cli",
      sessionId: "s-cli",
      workspaceRoot: dir,
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
      executionBoundary: {
        capabilities: {
          backend: "local-native",
          capabilityKinds: ["commit-file", "read-file", "process", "model-egress"],
          exactCommit: true,
          hostFilteredEgress: true,
          environmentIsolation: true,
          supportedOperationKinds: ["none", "read-file", "commit-files", "process"],
        },
        async execute(action) {
          return {
            state: "succeeded",
            result: { output: "created", success: true },
            evidence: {
              backend: "local-native",
              actionDigest: action.actionDigest,
              executorId: "test",
              operationKind: action.operation.kind,
            },
          };
        },
      },
      auditStore: audit,
      capabilityLedger: ledger,
      policyStore,
    });

    const cliResult = await cliLifecycle.lifecycle.run(cliAction);
    expect(cliResult.outcome.state).toBe("succeeded");

    // 2. Process 2 (SDK surface): Reads policy in the same workspace as "sdk-user" (the SDK default)
    const workspaceId = computeWorkspaceId(dir);
    const sdkRead = await policyStore.read(workspaceId, { principalId: "sdk-user", tenancyMode: "single" });

    // RED GATE ASSERTION:
    // Under the unified sentinel (FR-017), single mode uses "sdk-user" everywhere.
    // On the current tree, CLI stamped "cli-user", so sdkRead (filtering for "sdk-user")
    // cannot see the commit-file grant!
    const commitCap = sdkRead.policy.capabilities.find(
      (c) => c.kind === "commit-file" && c.path === targetFile,
    );
    expect(commitCap).toBeDefined();
  });
});
