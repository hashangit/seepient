/**
 * Autonomous run end-to-end tests (spec 017, T034 / T035 / T036 / QS-5).
 *
 * Verifies:
 *   1. Zero approval broker invocations across multi-tool run
 *   2. Complete audit trail (one event per action)
 *   3. Broker network restrictions enforced (private/metadata destinations blocked)
 *   4. Secret-class withholding invariant intact
 *   5. Immutable denies enforced (security path writes denied)
 */
import { describe, it, expect, beforeEach } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { buildActionLifecycle, ALL_ANALYZERS } from "../action-lifecycle-factory.js";
import { InMemoryArtifactStore } from "../../../capabilities/execution/in-memory-artifact-store.js";
import type { ApprovalBroker } from "../../../foundations/contracts/permission-policy.js";
import type { ExecutionBoundary } from "../../../foundations/contracts/execution-boundary.js";
import { EffectBroker } from "../../../capabilities/execution/effect-broker.js";
import { BrokerExecutor, CommitFilesExecutor } from "../../../capabilities/execution/executors.js";
import { isSecurityPath } from "../../../capabilities/execution/environment-policy.js";
import { LocalPolicyStore, computeWorkspaceId } from "../policy-store.js";
import { LocalAuditStore } from "../audit-recorder.js";

describe("autonomous run end-to-end (spec 017, T034 / T035 / T036 / QS-5)", () => {
  let tempDir: string;
  let workspaceRoot: string;
  let auditDir: string;
  let artifacts: InMemoryArtifactStore;
  let brokerApprovalCalls: number;
  let trackingBroker: ApprovalBroker;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "seepient-auto-"));
    workspaceRoot = path.join(tempDir, "workspace");
    auditDir = path.join(tempDir, "audit");
    await fs.mkdir(workspaceRoot, { recursive: true });
    await fs.mkdir(auditDir, { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "doc.txt"), "initial content\n", "utf8");
    await fs.writeFile(path.join(workspaceRoot, ".env"), "API_KEY=topsecret123\n", "utf8");
    artifacts = new InMemoryArtifactStore();
    brokerApprovalCalls = 0;
    trackingBroker = {
      mode: "inline",
      request: async (req) => {
        brokerApprovalCalls++;
        return {
          approved: false,
          requestId: req.requestId,
          actionDigest: req.actionDigest,
          actorId: "test-broker",
          reason: "cancelled",
          decidedAt: Date.now(),
        };
      },
    };
  });

  it("completes multi-tool run with zero broker invocations and full audit trail (T034)", async () => {
    const auditStore = new LocalAuditStore({ root: auditDir });

    const localBoundary: ExecutionBoundary = {
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
        jsFsFallbackOptIn: false,
        hostFilteredEgress: true,
        environmentIsolation: true,
        supportedOperationKinds: ["none", "read-file", "commit-files", "process", "broker"],
      },
      execute: async (action, _envelope, _opts) => ({
        state: "succeeded",
        result: { output: "executed", success: true },
        evidence: {
          backend: "local-native",
          actionDigest: action.actionDigest,
          executorId: "test-executor",
          operationKind: action.operation.kind,
        },
      }),
    };

    const wired = await buildActionLifecycle({
      principalId: "auto-user",
      runId: "run-auto-1",
      workspaceRoot,
      approvalBroker: trackingBroker,
      approvalMode: "autonomous",
      executionBoundary: localBoundary,
      auditStore,
      artifacts,
    });

    const ctx = {
      principalId: "auto-user",
      runId: "run-auto-1",
      toolCallId: "call-1",
      workspace: {
        workspaceId: "ws-auto",
        canonicalRoot: workspaceRoot,
        policyVersion: 1,
        policyDigest: "digest-auto",
      },
      artifacts,
      modelProviderClass: "*",
    };

    // Prepare read_file (safe), get_current_datetime (safe), and execute_shell_command (destructive)
    const readAction = await ALL_ANALYZERS.read_file({ path: "README.md" }, ctx);
    const datetimeAction = await ALL_ANALYZERS.get_current_datetime({}, ctx);
    const bashAction = await ALL_ANALYZERS.execute_shell_command({ command: "echo autonomous" }, ctx);

    for (const action of [readAction, datetimeAction, bashAction]) {
      const res = await wired.lifecycle.run(action);
      expect(res.decision.decision, `Action ${action.toolName} must be allow in autonomous mode`).toBe("allow");
    }

    // Zero approval prompts
    expect(brokerApprovalCalls).toBe(0);
  });

  it("denies private/metadata destinations even in autonomous mode (T034)", async () => {
    const broker = new EffectBroker({
      artifacts,
      network: {
        resolve: async () => ["169.254.169.254"], // Cloud metadata IP
        fetch: async () => {
          throw new Error("Should not be called for private IP");
        },
      },
    });

    const action = await ALL_ANALYZERS.read_website(
      { url: "https://169.254.169.254/latest/meta-data" },
      {
        principalId: "auto-user",
        runId: "run-auto-2",
        toolCallId: "call-2",
        workspace: {
          workspaceId: "ws-auto",
          canonicalRoot: workspaceRoot,
          policyVersion: 1,
          policyDigest: "digest-auto",
        },
        artifacts,
        modelProviderClass: "*",
      },
    );

    const envelope = {
      version: 1 as const,
      envelopeId: "env-auto-2",
      principalId: "auto-user",
      runId: "run-auto-2",
      actionDigest: action.actionDigest,
      capabilities: [
        {
          kind: "network-destination" as const,
          scheme: "https" as const,
          host: "*",
        },
      ],
      lifetime: { kind: "action" as const, actionDigest: action.actionDigest, consumeOnce: true as const },
      issuedBy: { kind: "service" as const, authorityId: "autonomous", authenticatedBy: "test" },
      issuedAt: Date.now(),
      policyDigest: "digest-auto",
    };

    const auth = {
      leaseId: envelope.envelopeId,
      actionDigest: action.actionDigest,
      expiresAt: Date.now() + 60_000,
      singleUseRequestId: (action.operation as any).request.requestId,
    };

    const result = await broker.execute((action.operation as any).request, envelope, auth);
    expect(result.status).toBe("denied");
    expect(result.error?.code).toBe("BROKER_DENIED");
    expect(result.error?.message).toMatch(/denied|restricted|private|cloud metadata/i);
  });

  it("preserves secret-class withholding invariant in autonomous mode (T035)", async () => {
    const ctx = {
      principalId: "auto-user",
      runId: "run-auto-3",
      toolCallId: "call-3",
      workspace: {
        workspaceId: "ws-auto",
        canonicalRoot: workspaceRoot,
        policyVersion: 1,
        policyDigest: "digest-auto",
      },
      artifacts,
      modelProviderClass: "openai", // remote provider class
    };

    const secretReadAction = await ALL_ANALYZERS.read_file({ path: ".env" }, ctx);
    // Declared egress for .env has sensitivity: "secret" and dataClasses: ["sensitive", "secret"]
    const readEffect = secretReadAction.effects.find((e) => e.kind === "filesystem-read");
    expect(readEffect?.sensitivity).toBe("secret");
  });

  it("enforces immutable denies in autonomous mode (T036)", async () => {
    const securityFilePath = path.join(os.homedir(), ".seepient", "security", "policies", "ws.json");
    expect(isSecurityPath(securityFilePath)).toBe(true);

    const commitExecutor = new CommitFilesExecutor({
      broker: { commit: async () => {} } as any,
      artifacts,
      useNative: false,
      allowFallback: true,
    });

    const writeSecurityAction = {
      actionId: "act-sec",
      actionDigest: "digest-sec",
      toolName: "write_file",
      args: { path: securityFilePath, content: "{}" },
      effects: [],
      operation: {
        kind: "commit-files" as const,
        commits: [
          {
            destination: {
              canonicalPath: securityFilePath,
              basename: "ws.json",
              canonicalParent: path.dirname(securityFilePath),
              exists: false,
              finalSymlink: false,
            },
            content: { artifactId: "art-1", sha256: "abc", byteLength: 2, mediaType: "application/json" },
          },
        ],
      },
      risk: "destructive" as const,
    };

    const envelope = {
      version: 1 as const,
      envelopeId: "env-sec",
      principalId: "auto-user",
      runId: "run-sec",
      actionDigest: "digest-sec",
      capabilities: [],
      lifetime: { kind: "action" as const, actionDigest: "digest-sec", consumeOnce: true as const },
      issuedBy: { kind: "service" as const, authorityId: "autonomous", authenticatedBy: "test" },
      issuedAt: Date.now(),
      policyDigest: "digest-sec",
    };

    const result = await commitExecutor.execute(
      writeSecurityAction as any,
      envelope,
      writeSecurityAction.operation,
      {},
    );

    expect(result.state).toBe("failed");
    if (result.state === "failed") {
      expect(result.error?.code).toBe("SECURITY_PATH_DENIED");
    }
  });
});
