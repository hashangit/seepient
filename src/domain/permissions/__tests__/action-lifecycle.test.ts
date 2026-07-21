/**
 * P1 ActionLifecycle + AuditRecorder tests (spec 008, T109/T110).
 *
 * Verifies the end-to-end pipeline with in-memory fakes:
 *  - allow path produces one terminal `succeeded` event + tool result
 *  - denial produces one terminal `denied` event, no dispatch
 *  - approval is requested once; bad/expired/mismatched responses deny
 *  - headless (none broker) never waits
 *  - audit is idempotent on `<actionId>:<state>`
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionLifecycle } from "../action-lifecycle.js";
import { PolicyEngine } from "../policy-engine.js";
import { LocalAuditStore, idempotencyKey } from "../audit-recorder.js";
import type {
  ApprovalBroker,
  Capability,
  CapabilityEnvelope,
  CapabilitySet,
  PermissionDecision,
  PermissionRequest,
  PolicyContext,
} from "../../../foundations/contracts/permission-policy.js";
import type {
  ExecutionBoundary,
  ExecutionBackendCapabilities,
  ExecutionResult,
} from "../../../foundations/contracts/execution-boundary.js";
import type { PreparedToolAction } from "../../../foundations/contracts/prepared-action.js";
import type { ToolResult } from "../../../foundations/types.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seepient-audit-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const LOCAL_BACKEND: ExecutionBackendCapabilities = {
  backend: "local-native",
  capabilityKinds: ["commit-file", "read-file", "process", "model-egress"],
  exactCommit: true,
  hostFilteredEgress: true,
  environmentIsolation: true,
  supportedOperationKinds: ["none", "read-file", "commit-files", "process"],
};

function set(...caps: Capability[]): CapabilitySet {
  return { version: 1, capabilities: caps };
}

function policyCtx(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    deploymentCeiling: set({ kind: "commit-file", path: "/p/a.txt" }),
    principalPolicy: set({ kind: "commit-file", path: "/p/a.txt" }),
    runtimeBaseline: set({ kind: "commit-file", path: "/p/a.txt" }),
    activeCapabilities: set(),
    immutableDenies: [],
    approvalMode: "manual",
    interaction: { mode: "inline", deadlineMs: 30_000 },
    backendCapabilities: LOCAL_BACKEND,
    ...overrides,
  };
}

function writeAction(actionDigest = "d1"): PreparedToolAction {
  return {
    version: 1,
    actionId: "a1",
    runId: "r1",
    toolCallId: "c1",
    toolName: "write_file",
    principalId: "user",
    argsDigest: "args",
    actionDigest,
    risk: "edit",
    effects: [
      {
        kind: "filesystem-write",
        targets: [
          {
            target: {
              canonicalPath: "/p/a.txt",
              canonicalParent: "/p",
              basename: "a.txt",
              exists: false,
              finalSymlink: false,
            },
            mode: "create",
          },
        ],
      },
    ],
    display: {
      title: "write",
      summary: "/p/a.txt",
      canonicalTargets: ["/p/a.txt"],
      effects: ["filesystem-write"],
    },
    operation: {
      kind: "commit-files",
      commits: [
        {
          destination: {
            canonicalPath: "/p/a.txt",
            canonicalParent: "/p",
            basename: "a.txt",
            exists: false,
            finalSymlink: false,
          },
          content: {
            artifactId: "art1",
            sha256: "x",
            byteLength: 4,
            mediaType: "text/plain",
          },
        },
      ],
    },
  };
}

/** Fake approval broker that returns a canned decision. */
function fakeBroker(decision: PermissionDecision | "throw"): ApprovalBroker {
  return {
    mode: "inline",
    async request(req: PermissionRequest): Promise<PermissionDecision> {
      if (decision === "throw") throw new Error("broker down");
      // Honor the action digest from the request.
      if (decision.approved) {
        return {
          ...decision,
          requestId: req.requestId,
          actionDigest: req.actionDigest,
        } as PermissionDecision;
      }
      return {
        ...decision,
        requestId: req.requestId,
        actionDigest: req.actionDigest,
      } as PermissionDecision;
    },
  };
}

/** Fake execution boundary that succeeds with a canned result. */
function fakeBoundary(result: ToolResult, opts?: { throwOnExec?: boolean }): ExecutionBoundary {
  return {
    capabilities: LOCAL_BACKEND,
    async execute(
      _action: PreparedToolAction,
      _env: CapabilityEnvelope,
    ): Promise<ExecutionResult> {
      if (opts?.throwOnExec) throw new Error("exec failed");
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

function approved(req: PermissionRequest, actor = "user"): PermissionDecision {
  return {
    approved: true,
    requestId: req.requestId,
    actionDigest: req.actionDigest,
    lifetime: "action",
    actorId: actor,
    decidedAt: Date.now(),
  };
}

describe("ActionLifecycle (T110)", () => {
  it("allow path: one terminal succeeded event, one tool result", async () => {
    const audit = new LocalAuditStore({ root: dir });
    const lifecycle = new ActionLifecycle({
      policy: new PolicyEngine("digest"),
      policyContext: policyCtx({
        activeCapabilities: set({ kind: "commit-file", path: "/p/a.txt" }),
      }),
      broker: fakeBroker({ approved: false, requestId: "", actionDigest: "", actorId: "u", decidedAt: 0 }),
      boundary: fakeBoundary({ output: "ok", success: true }),
      audit,
      activeCapabilities: { capabilities: [] },
    });
    const result = await lifecycle.run(writeAction());
    expect(result.outcome.state).toBe("succeeded");
    expect(result.toolResult.output).toBe("ok");

    const terminal = await audit.getTerminal("a1");
    expect(terminal?.state).toBe("succeeded");
  });

  it("needs-approval then approved: ONE request, ONE dispatch", async () => {
    const audit = new LocalAuditStore({ root: dir });
    let requestCount = 0;
    const broker: ApprovalBroker = {
      mode: "inline",
      async request(req: PermissionRequest) {
        requestCount++;
        return approved(req);
      },
    };
    const lifecycle = new ActionLifecycle({
      policy: new PolicyEngine("digest"),
      policyContext: policyCtx({ activeCapabilities: set() }),
      broker,
      boundary: fakeBoundary({ output: "done", success: true }),
      audit,
      activeCapabilities: { capabilities: [] },
    });
    const result = await lifecycle.run(writeAction());
    expect(requestCount).toBe(1);
    expect(result.outcome.state).toBe("succeeded");
    expect(result.approval?.approved).toBe(true);
  });

  it("denial: exactly one terminal denied event, NO dispatch, no afterToolCall equivalent", async () => {
    const audit = new LocalAuditStore({ root: dir });
    let execCount = 0;
    const boundary = fakeBoundary({ output: "should-not-run", success: true });
    const countingBoundary: ExecutionBoundary = {
      capabilities: boundary.capabilities,
      async execute(...args) {
        execCount++;
        return boundary.execute(...args[0] ? args : ([{}, {}, {}] as never));
      },
    };
    const broker: ApprovalBroker = {
      mode: "inline",
      async request(req) {
        return {
          approved: false,
          requestId: req.requestId,
          actionDigest: req.actionDigest,
          actorId: "u",
          decidedAt: Date.now(),
        };
      },
    };
    const lifecycle = new ActionLifecycle({
      policy: new PolicyEngine("digest"),
      policyContext: policyCtx({ activeCapabilities: set() }),
      broker,
      boundary: countingBoundary,
      audit,
      activeCapabilities: { capabilities: [] },
    });
    const result = await lifecycle.run(writeAction());
    expect(execCount).toBe(0);
    expect(result.outcome.state).toBe("denied");
    expect(result.outcome.denial).toBe("user-denied");

    const terminal = await audit.getTerminal("a1");
    expect(terminal?.state).toBe("denied");
  });

  it("headless (none mode): denies immediately, never calls broker", async () => {
    const audit = new LocalAuditStore({ root: dir });
    let brokerCalled = 0;
    const broker: ApprovalBroker = {
      mode: "none",
      async request() {
        brokerCalled++;
        return { approved: false, requestId: "", actionDigest: "", actorId: "u", decidedAt: 0 };
      },
    };
    const lifecycle = new ActionLifecycle({
      policy: new PolicyEngine("digest"),
      policyContext: policyCtx({ interaction: { mode: "none" }, activeCapabilities: set() }),
      broker,
      boundary: fakeBoundary({ output: "x", success: true }),
      audit,
      activeCapabilities: { capabilities: [] },
    });
    const result = await lifecycle.run(writeAction());
    expect(brokerCalled).toBe(0);
    expect(result.outcome.state).toBe("denied");
    expect(result.outcome.denial).toBe("approval-unavailable");
  });

  it("invalid approval response (wrong actionDigest) denies", async () => {
    const audit = new LocalAuditStore({ root: dir });
    const broker: ApprovalBroker = {
      mode: "inline",
      async request(req) {
        return {
          approved: true,
          requestId: req.requestId,
          actionDigest: "wrong-digest",
          lifetime: "action",
          actorId: "u",
          decidedAt: Date.now(),
        };
      },
    };
    const lifecycle = new ActionLifecycle({
      policy: new PolicyEngine("digest"),
      policyContext: policyCtx({ activeCapabilities: set() }),
      broker,
      boundary: fakeBoundary({ output: "x", success: true }),
      audit,
      activeCapabilities: { capabilities: [] },
    });
    const result = await lifecycle.run(writeAction());
    expect(result.outcome.state).toBe("denied");
    expect(result.outcome.denial).toBe("invalid-approval-response");
  });

  it("audit is idempotent on actionId:state (replay safe)", async () => {
    const audit = new LocalAuditStore({ root: dir });
    const event = {
      eventId: "e1",
      actionId: "aX",
      actionDigest: "dX",
      principalId: "user",
      runId: "r1",
      state: "succeeded" as const,
      timestamp: Date.now(),
      policyDigest: "dig",
    };
    const key = idempotencyKey("aX", "succeeded");
    const first = await audit.append(event, { idempotencyKey: key });
    const second = await audit.append(event, { idempotencyKey: key });
    expect(first).toBe("written");
    expect(second).toBe("duplicate");
    const terminal = await audit.getTerminal("aX");
    expect(terminal?.state).toBe("succeeded");
  });

  it("pre-dispatch audit failure denies effectful execution", async () => {
    // Use a broken audit that always throws on append.
    const brokenAudit = {
      async append() {
        throw new Error("disk full");
      },
      async getTerminal() {
        return undefined;
      },
    };
    const lifecycle = new ActionLifecycle({
      policy: new PolicyEngine("digest"),
      policyContext: policyCtx({
        activeCapabilities: set({ kind: "commit-file", path: "/p/a.txt" }),
      }),
      broker: fakeBroker({ approved: false, requestId: "", actionDigest: "", actorId: "u", decidedAt: 0 }),
      boundary: fakeBoundary({ output: "should-not-run", success: true }),
      audit: brokenAudit,
      activeCapabilities: { capabilities: [] },
    });
    // The lifecycle records "prepared" first; a broken audit throws there.
    await expect(lifecycle.run(writeAction())).rejects.toThrow();
  });
});
