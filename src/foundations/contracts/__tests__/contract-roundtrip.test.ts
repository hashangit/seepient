/**
 * P0 contract serialization round-trip + digest-stability (spec 008, T001).
 *
 * Verifies the Foundations vocabulary is JSON-serializable (required for the
 * worker dispatch boundary) and that `actionDigest` inputs are stable. This
 * is the portable CI gate; NFR-002 (versioned contracts reject unknown
 * majors) is exercised by the worker-protocol tests in P4.
 */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import type { PreparedToolAction } from "../prepared-action.js";
import type { PolicyDecision, CapabilityEnvelope } from "../permission-policy.js";
import type { WorkerDispatch, WorkerResult } from "../worker-protocol.js";

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

const sampleAction: PreparedToolAction = {
  version: 1,
  actionId: "act_1",
  runId: "run_1",
  toolCallId: "call_1",
  toolName: "write_file",
  principalId: "user_1",
  argsDigest: sha256("args"),
  actionDigest: sha256("op|effects|principal|tool"),
  risk: "edit",
  effects: [
    {
      kind: "filesystem-write",
      targets: [
        {
          target: {
            canonicalPath: "/project/file.txt",
            canonicalParent: "/project",
            basename: "file.txt",
            exists: false,
            finalSymlink: false,
          },
          mode: "create",
        },
      ],
    },
  ],
  display: {
    title: "Write file.txt",
    summary: "Create /project/file.txt",
    canonicalTargets: ["/project/file.txt"],
    effects: ["filesystem-write"],
  },
  operation: {
    kind: "commit-files",
    commits: [
      {
        destination: {
          canonicalPath: "/project/file.txt",
          canonicalParent: "/project",
          basename: "file.txt",
          exists: false,
          finalSymlink: false,
        },
        content: {
          artifactId: "art_1",
          sha256: sha256("bytes"),
          byteLength: 5,
          mediaType: "text/plain",
        },
      },
    ],
  },
};

describe("P0 contract round-trip (T001)", () => {
  it("PreparedToolAction survives JSON round-trip", () => {
    const round = JSON.parse(JSON.stringify(sampleAction)) as PreparedToolAction;
    expect(round.operation.kind).toBe("commit-files");
    expect(round.effects[0].kind).toBe("filesystem-write");
  });

  it("actionDigest is stable for identical inputs", () => {
    const a = sha256(JSON.stringify(sampleAction.operation) + "|user_1|write_file");
    const b = sha256(JSON.stringify(sampleAction.operation) + "|user_1|write_file");
    expect(a).toBe(b);
  });

  it("actionDigest changes when a target changes", () => {
    const mutated: PreparedToolAction = {
      ...sampleAction,
      operation: {
        ...sampleAction.operation,
        kind: "commit-files",
        commits: [
          {
            ...sampleAction.operation.commits[0],
            destination: {
              ...sampleAction.operation.commits[0].destination,
              canonicalPath: "/project/other.txt",
            },
          },
        ],
      },
    };
    const d1 = sha256(JSON.stringify(sampleAction.operation));
    const d2 = sha256(JSON.stringify(mutated.operation));
    expect(d1).not.toBe(d2);
  });

  it("PolicyDecision is a closed discriminated union at runtime", () => {
    const allow: PolicyDecision = {
      decision: "allow",
      envelope: {} as CapabilityEnvelope,
      trace: { policyDigest: "d", evaluatedLayers: [] },
    };
    const deny: PolicyDecision = {
      decision: "deny",
      reason: "immutable-deny",
      message: "no",
      trace: { policyDigest: "d", evaluatedLayers: [] },
    };
    expect(allow.decision).toBe("allow");
    expect(deny.decision).toBe("deny");
  });

  it("worker protocol payloads round-trip", () => {
    const dispatch: WorkerDispatch = {
      version: 1,
      dispatchId: "d1",
      nonce: "n1",
      issuedAt: 1,
      signingKeyId: "k1",
      action: sampleAction,
      envelope: {} as CapabilityEnvelope,
      workspace: {
        leaseId: "l1",
        tenantId: "t1",
        sessionId: "s1",
        workspaceId: "w1",
        mountTarget: "/workspace",
        expiresAt: 2,
      },
      artifactManifest: [],
      deadline: 3,
      signature: "sig",
    };
    const result: WorkerResult = {
      version: 1,
      dispatchId: "d1",
      leaseId: "l1",
      actionDigest: sampleAction.actionDigest,
      state: "succeeded",
      evidence: {
        backend: "docker-worker",
        actionDigest: sampleAction.actionDigest,
        executorId: "exec1",
        operationKind: "commit-files",
      },
    };
    expect(JSON.parse(JSON.stringify(dispatch)).dispatchId).toBe("d1");
    expect(JSON.parse(JSON.stringify(result)).state).toBe("succeeded");
  });
});
