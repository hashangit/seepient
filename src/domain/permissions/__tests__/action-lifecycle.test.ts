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
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionLifecycle } from "../action-lifecycle.js";
import { PolicyEngine } from "../policy-engine.js";
import { LocalAuditStore, TerminalEventOutbox, idempotencyKey } from "../audit-recorder.js";
import { LocalPolicyStore, GLOBAL_WORKSPACE_ID } from "../policy-store.js";
import { buildActionLifecycle } from "../action-lifecycle-factory.js";
import { PersistedCapabilityLedger } from "../persisted-capability-ledger.js";
import { InMemoryArtifactStore } from "../../../capabilities/execution/in-memory-artifact-store.js";
import { buildLocalBoundary } from "../../../capabilities/execution/build-local-boundary.js";
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

function approved(req: PermissionRequest, actor = "user", lifetime: "action" | "run" | "session" | "project" | "global" = "action", optionId?: string): PermissionDecision {
  return {
    approved: true,
    requestId: req.requestId,
    actionDigest: req.actionDigest,
    // Spec 011: an approved decision must name a policy-issued option.
    optionId: optionId ?? req.approvalOptions[0]?.optionId ?? "opt-1",
    lifetime,
    actorId: actor,
    decidedAt: Date.now(),
  };
}

/** Approve the SECOND (bounded) option — the exact option is always first. */
function approvedBounded(req: PermissionRequest): PermissionDecision {
  const option = req.approvalOptions.find((o) => o.kind === "bounded");
  return {
    approved: true,
    requestId: req.requestId,
    actionDigest: req.actionDigest,
    optionId: option?.optionId ?? req.approvalOptions[0]?.optionId ?? "opt-1",
    lifetime: "action",
    actorId: "user",
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
          optionId: req.approvalOptions[0]?.optionId ?? "opt-1",
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

  // ── Spec 011 (T009/T019): selection validation, envelope issuance, and
  //    authority integrity ────────────────────────────────────────────────

  function processAction(actionDigest = "d-proc"): PreparedToolAction {
    return {
      version: 1,
      actionId: "a-proc",
      runId: "r1",
      toolCallId: "c1",
      toolName: "execute_shell_command",
      principalId: "user",
      argsDigest: "args",
      actionDigest,
      risk: "destructive",
      effects: [
        {
          kind: "process-exec",
          command: { executable: "/usr/bin/git", argv: ["status", "--porcelain"], cwd: "/p" },
          requestedRoots: [],
        },
      ],
      display: {
        title: "run",
        summary: "git status",
        canonicalTargets: [],
        effects: ["process-exec"],
      },
      operation: {
        kind: "process",
        command: { executable: "/usr/bin/git", argv: ["status", "--porcelain"], cwd: "/p" },
        roots: [],
      },
    };
  }

  it("issues an envelope with the SELECTED option's capabilities exactly (bounded)", async () => {
    const audit = new LocalAuditStore({ root: dir });
    let issued: CapabilityEnvelope | undefined;
    const recordingBoundary: ExecutionBoundary = {
      capabilities: LOCAL_BACKEND,
      async execute(_a, envelope) {
        issued = envelope;
        return {
          state: "succeeded",
          result: { output: "ok", success: true },
          evidence: {
            backend: "local-native",
            actionDigest: _a.actionDigest,
            executorId: "test",
            operationKind: _a.operation.kind,
          },
        };
      },
    };
    const ctx = policyCtx({
      sessionId: "sess-1",
      deploymentCeiling: set({ kind: "process" }),
      principalPolicy: set({ kind: "process" }),
      runtimeBaseline: set({ kind: "process" }),
      activeCapabilities: set(),
    });
    // The bounded option is session-only (FR-010): approve bounded/session,
    // the only Domain-issued choice for it.
    const broker: ApprovalBroker = {
      mode: "inline",
      async request(req) {
        const bounded = req.approvalOptions.find((o) => o.kind === "bounded");
        return approved(req, "user", "session", bounded?.optionId);
      },
    };
    const lifecycle = new ActionLifecycle({
      policy: new PolicyEngine("digest"),
      policyContext: ctx,
      broker,
      boundary: recordingBoundary,
      audit,
      activeCapabilities: { capabilities: [] },
      sessionId: "sess-1",
    });
    const result = await lifecycle.run(processAction());
    expect(result.outcome.state).toBe("succeeded");
    expect(issued).toBeDefined();
    // The final envelope carries the bounded option's capabilities exactly —
    // never the action's narrower required set, never a wider fallback.
    expect(issued!.capabilities).toEqual([
      { kind: "process", executable: "/usr/bin/git", argvPrefix: ["status"] },
    ]);
    expect(issued!.lifetime.kind).toBe("session");
  });

  it("action-lifetime approval is consumed once: a matching later action asks again", async () => {
    const audit = new LocalAuditStore({ root: dir });
    let requestCount = 0;
    const broker: ApprovalBroker = {
      mode: "inline",
      async request(req) {
        requestCount++;
        return approved(req);
      },
    };
    const lifecycle = new ActionLifecycle({
      policy: new PolicyEngine("digest"),
      policyContext: policyCtx({ activeCapabilities: set() }),
      broker,
      boundary: fakeBoundary({ output: "ok", success: true }),
      audit,
      activeCapabilities: { capabilities: [] },
    });
    const first = await lifecycle.run(writeAction());
    expect(first.outcome.state).toBe("succeeded");
    expect(requestCount).toBe(1);
    // Same action again: Allow Once must NOT be retained as session authority.
    const second = await lifecycle.run(writeAction());
    expect(second.outcome.state).toBe("succeeded");
    expect(requestCount).toBe(2);
    // The action-scoped capability was not retained in the active set.
    expect(lifecycle.getActiveCapabilities()).toEqual([]);
  });

  it("session-lifetime approval IS retained: a matching later action does not ask again", async () => {
    const audit = new LocalAuditStore({ root: dir });
    let requestCount = 0;
    const broker: ApprovalBroker = {
      mode: "inline",
      async request(req) {
        requestCount++;
        return approved(req, "user", "session");
      },
    };
    const lifecycle = new ActionLifecycle({
      policy: new PolicyEngine("digest"),
      policyContext: policyCtx({
        sessionId: "sess-1",
        activeCapabilities: set(),
      }),
      broker,
      boundary: fakeBoundary({ output: "ok", success: true }),
      audit,
      activeCapabilities: { capabilities: [] },
      sessionId: "sess-1",
    });
    const first = await lifecycle.run(writeAction());
    expect(first.outcome.state).toBe("succeeded");
    expect(requestCount).toBe(1);
    const second = await lifecycle.run(writeAction());
    expect(second.outcome.state).toBe("succeeded");
    expect(requestCount).toBe(1); // no repeat prompt
  });

  it("forged option ID denies with invalid-approval-response", async () => {
    const audit = new LocalAuditStore({ root: dir });
    const broker: ApprovalBroker = {
      mode: "inline",
      async request(req) {
        return {
          approved: true,
          requestId: req.requestId,
          actionDigest: req.actionDigest,
          optionId: "forged-option",
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

  it("approved decision whose option/lifetime pair is not a Domain-issued choice denies (T030)", async () => {
    const audit = new LocalAuditStore({ root: dir });
    let dispatchCount = 0;
    const boundary: ExecutionBoundary = {
      capabilities: LOCAL_BACKEND,
      async execute(a, _env) {
        dispatchCount++;
        return {
          state: "succeeded",
          result: { output: "should-not-run", success: true },
          evidence: {
            backend: "local-native",
            actionDigest: a.actionDigest,
            executorId: "test",
            operationKind: a.operation.kind,
          },
        };
      },
    };
    // A session identity exists, so the request offers exact/action,
    // exact/session, and bounded/session — bounded/action is never a
    // Domain-issued choice (FR-010). The broker names the bounded option
    // with an action lifetime: the pair is individually offered but is NOT
    // one of the request's complete choices (T030 defense in depth).
    const ctx = policyCtx({
      sessionId: "sess-1",
      deploymentCeiling: set({ kind: "process" }),
      principalPolicy: set({ kind: "process" }),
      runtimeBaseline: set({ kind: "process" }),
      activeCapabilities: set(),
    });
    const broker: ApprovalBroker = {
      mode: "inline",
      async request(req) {
        return approvedBounded(req); // bounded option + action lifetime
      },
    };
    const lifecycle = new ActionLifecycle({
      policy: new PolicyEngine("digest"),
      policyContext: ctx,
      broker,
      boundary,
      audit,
      activeCapabilities: { capabilities: [] },
      sessionId: "sess-1",
    });
    const result = await lifecycle.run(processAction());
    expect(result.outcome.state).toBe("denied");
    expect(result.outcome.denial).toBe("invalid-approval-response");
    expect(dispatchCount).toBe(0);
  });

  it("unsupported lifetime denies with invalid-approval-response", async () => {
    const audit = new LocalAuditStore({ root: dir });
    const broker: ApprovalBroker = {
      mode: "inline",
      async request(req) {
        // Session is not offered: no session identity in the context.
        return approved(req, "user", "session");
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

  it("expired request denies with approval-expired even when the broker approves", async () => {
    const audit = new LocalAuditStore({ root: dir });
    const broker: ApprovalBroker = {
      mode: "inline",
      async request(req) {
        return approved(req);
      },
    };
    const lifecycle = new ActionLifecycle({
      policy: new PolicyEngine("digest"),
      policyContext: policyCtx({ activeCapabilities: set() }),
      broker,
      boundary: fakeBoundary({ output: "x", success: true }),
      audit,
      activeCapabilities: { capabilities: [] },
      // The request was created with a 30s deadline; run 40s later.
      now: () => Date.now() + 40_000,
    });
    const result = await lifecycle.run(writeAction());
    expect(result.outcome.state).toBe("denied");
    expect(result.outcome.denial).toBe("approval-expired");
  });

  it("revoked session denies a session approval with capability-revoked", async () => {
    const ledger = new PersistedCapabilityLedger({ root: dir });
    await ledger.load();
    await ledger.revoke({ sessionId: "sess-revoked" });
    const audit = new LocalAuditStore({ root: dir });
    const broker: ApprovalBroker = {
      mode: "inline",
      async request(req) {
        return approved(req, "user", "session");
      },
    };
    const lifecycle = new ActionLifecycle({
      policy: new PolicyEngine("digest"),
      policyContext: policyCtx({
        sessionId: "sess-revoked",
        activeCapabilities: set(),
      }),
      broker,
      boundary: fakeBoundary({ output: "x", success: true }),
      audit,
      activeCapabilities: { capabilities: [] },
      capabilityLedger: ledger,
      sessionId: "sess-revoked",
    });
    const result = await lifecycle.run(writeAction());
    expect(result.outcome.state).toBe("denied");
    expect(result.outcome.denial).toBe("capability-revoked");
  });

  it("inline approval writes no grants or protected-policy files", async () => {
    const artifacts = new InMemoryArtifactStore();
    const { boundary } = await buildLocalBoundary({ artifacts, allowFallback: true });

    // The commit-files operation reads its content from the shared artifact
    // store (the analyzer would have stored it; this test bypasses analysis).
    const contentRef = await artifacts.put(Buffer.from("hello\n"), "text/plain", "r1");
    const securityDir = join(dir, "security");
    const prevEnv = process.env.SEEPIENT_SECURITY_DIR;
    process.env.SEEPIENT_SECURITY_DIR = securityDir;
    try {
      const wired = await buildActionLifecycle({
        principalId: "u1",
        runId: "r1",
        workspaceRoot: dir,
        modelProviderClass: "openai",
        // A TUI-shaped broker, faked inline so the Domain test stays inside
        // the Domain layer (no transport import in this test file).
        approvalBroker: {
          mode: "inline",
          async request(req) {
            return {
              approved: true,
              requestId: req.requestId,
              actionDigest: req.actionDigest,
              optionId: req.approvalOptions[0]?.optionId ?? "opt-1",
              lifetime: "action",
              actorId: "inline-broker",
              decidedAt: Date.now(),
            };
          },
        },
        executionBoundary: boundary,
        auditRoot: dir,
        artifacts,
      });
      const file = join(dir, "approved.txt");
      const action: PreparedToolAction = {
        version: 1,
        actionId: "a-write",
        runId: "r1",
        toolCallId: "c1",
        toolName: "write_file",
        principalId: "u1",
        argsDigest: "a1",
        actionDigest: "ad-write",
        risk: "edit",
        effects: [
          {
            kind: "filesystem-write",
            targets: [
              {
                target: {
                  canonicalPath: file,
                  canonicalParent: dir,
                  basename: "approved.txt",
                  exists: false,
                  finalSymlink: false,
                },
                mode: "create",
                expected: { exists: false },
              },
            ],
          },
        ],
        operation: {
          kind: "commit-files",
          commits: [
            {
              destination: {
                canonicalPath: file,
                canonicalParent: dir,
                basename: "approved.txt",
                exists: false,
                finalSymlink: false,
              },
              content: contentRef,
              expected: { exists: false },
            },
          ],
        },
        display: {
          title: "Write file",
          summary: "Write file",
          canonicalTargets: [file],
          effects: ["filesystem-write"],
        },
      };
      const result = await wired.lifecycle.run(action);
      expect(result.outcome.state).toBe("succeeded");
      // Inline approval must not write grants files…
      expect(existsSync(join(dir, "grants.json"))).toBe(false);
      // …and must not create the protected policy store directory at all.
      expect(existsSync(join(securityDir, "policies"))).toBe(false);
    } finally {
      if (prevEnv === undefined) delete process.env.SEEPIENT_SECURITY_DIR;
      else process.env.SEEPIENT_SECURITY_DIR = prevEnv;
    }
  });

  it("revoked session authority does not authorize later actions (P0 review fix)", async () => {
    const ledger = new PersistedCapabilityLedger({ root: dir });
    await ledger.load();
    const audit = new LocalAuditStore({ root: dir });
    let requestCount = 0;
    let dispatchCount = 0;
    const broker: ApprovalBroker = {
      mode: "inline",
      async request(req) {
        requestCount++;
        return approved(req, "user", "session");
      },
    };
    const boundary: ExecutionBoundary = {
      capabilities: LOCAL_BACKEND,
      async execute(a, _env) {
        dispatchCount++;
        return {
          state: "succeeded",
          result: { output: "ok", success: true },
          evidence: {
            backend: "local-native",
            actionDigest: a.actionDigest,
            executorId: "test",
            operationKind: a.operation.kind,
          },
        };
      },
    };
    const lifecycle = new ActionLifecycle({
      policy: new PolicyEngine("digest"),
      policyContext: policyCtx({
        sessionId: "sess-rev-1",
        activeCapabilities: set(),
      }),
      broker,
      boundary,
      audit,
      activeCapabilities: { capabilities: [] },
      capabilityLedger: ledger,
      // The actions themselves carry NO sessionId (production analyzers do
      // not propagate it) — the lifecycle-bound identity must be used.
      sessionId: "sess-rev-1",
    });

    const first = await lifecycle.run(writeAction());
    expect(first.outcome.state).toBe("succeeded");
    expect(requestCount).toBe(1);

    await ledger.revoke({ sessionId: "sess-rev-1" });

    // A matching later action must fail closed: no repeat prompt, no dispatch.
    const second = await lifecycle.run(writeAction());
    expect(second.outcome.state).toBe("denied");
    expect(second.outcome.denial).toBe("capability-revoked");
    expect(requestCount).toBe(1);
    expect(dispatchCount).toBe(1);
  });

  it("action-lifetime approval never strips pre-existing active authority (review fix)", async () => {
    const baseline: Capability = {
      kind: "model-egress",
      providerClass: "*",
      dataClasses: ["normal", "sensitive"],
    };
    const audit = new LocalAuditStore({ root: dir });
    const lifecycle = new ActionLifecycle({
      policy: new PolicyEngine("digest"),
      policyContext: policyCtx({
        // The ceilings must cover model-egress for the action's egress
        // effect; the commit-file is what needs approval.
        deploymentCeiling: set(baseline, { kind: "commit-file", path: "/p/a.txt" }),
        principalPolicy: set(baseline, { kind: "commit-file", path: "/p/a.txt" }),
        runtimeBaseline: set(baseline, { kind: "commit-file", path: "/p/a.txt" }),
        activeCapabilities: set(baseline),
      }),
      broker: {
        mode: "inline",
        async request(req) {
          return approved(req);
        },
      },
      boundary: fakeBoundary({ output: "ok", success: true }),
      audit,
      activeCapabilities: { capabilities: [baseline] },
    });
    // The action requires filesystem-write AND model-egress (like the real
    // write_file analyzer); model-egress is covered by the baseline, the
    // commit-file needs approval.
    const action: PreparedToolAction = {
      ...writeAction(),
      effects: [
        ...writeAction().effects,
        { kind: "model-egress", providerClass: "normal", dataClasses: ["normal"], sources: [] },
      ],
    };
    const result = await lifecycle.run(action);
    expect(result.outcome.state).toBe("succeeded");
    // The baseline model-egress authority must survive the action approval
    // (Allow Once is consumed once; it never removes what already existed).
    expect(lifecycle.getActiveCapabilities()).toEqual([baseline]);
  });

  it("a broker cannot widen an approval by mutating the request (P0 review fix)", async () => {
    const audit = new LocalAuditStore({ root: dir });
    let dispatchCount = 0;
    const boundary: ExecutionBoundary = {
      capabilities: LOCAL_BACKEND,
      async execute(a, _env) {
        dispatchCount++;
        return {
          state: "succeeded",
          result: { output: "ok", success: true },
          evidence: {
            backend: "local-native",
            actionDigest: a.actionDigest,
            executorId: "test",
            operationKind: a.operation.kind,
          },
        };
      },
    };
    const ctx = policyCtx({
      deploymentCeiling: set({ kind: "process" }),
      principalPolicy: set({ kind: "process" }),
      runtimeBaseline: set({ kind: "process" }),
      activeCapabilities: set(),
    });
    // Malicious/buggy presenter: keep the valid option ID but try to widen
    // the option's capabilities into unrestricted process authority.
    const broker: ApprovalBroker = {
      mode: "inline",
      async request(req) {
        const opt = req.approvalOptions[0];
        if (opt) {
          // The broker-facing request is a deeply frozen clone; this
          // mutation attempt is exactly the attack the regression tests —
          // it throws in strict mode and must fail the round-trip.
          const mutableOption = opt as { capabilities: Capability[] };
          mutableOption.capabilities = [{ kind: "process" }];
        }
        return approved(req);
      },
    };
    const lifecycle = new ActionLifecycle({
      policy: new PolicyEngine("digest"),
      policyContext: ctx,
      broker,
      boundary,
      audit,
      activeCapabilities: { capabilities: [] },
    });
    // The broker receives a deeply frozen clone: the mutation throws, the
    // broker round-trip fails, and the action fails closed as
    // approval-unavailable — the widened authority is never issued.
    const result = await lifecycle.run(processAction());
    expect(result.outcome.state).toBe("denied");
    expect(result.outcome.denial).toBe("approval-unavailable");
    expect(dispatchCount).toBe(0);
    expect(lifecycle.getActiveCapabilities()).toEqual([]);
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

describe("persistent approval choices (spec 011 project/global)", () => {
  /** Force a needs-approval request: empty ACTIVE set, principal already
   *  covers the approvable cap (the engine intersects principal with active,
   *  so the empty active set gates the prompt and the approval unblocks it). */
  function approvalContext(workspaceId?: string): PolicyContext {
    return policyCtx({
      deploymentCeiling: set({ kind: "commit-file", path: "/p/a.txt" }),
      principalPolicy: set({ kind: "commit-file", path: "/p/a.txt" }),
      activeCapabilities: set(),
      workspaceId,
    });
  }

  it("project approval persists to the protected store via compare-and-set and runs", async () => {
    const store = new LocalPolicyStore({ root: dir });
    const lifecycle = new ActionLifecycle({
      policy: new PolicyEngine("digest"),
      policyContext: approvalContext("ws-1"),
      broker: {
        mode: "inline",
        request: async (req) => approved(req, "user", "project"),
      },
      boundary: fakeBoundary({ output: "ok", success: true }),
      audit: new LocalAuditStore({ root: dir }),
      activeCapabilities: { capabilities: [] },
      policyStore: store,
      workspaceId: "ws-1",
      terminalOutbox: { enqueue: async () => {} },
    });
    const result = await lifecycle.run(writeAction());
    expect(result.outcome.state).toBe("succeeded");
    // The capability landed in the PROJECT protected policy, outside
    // executor roots, via the same CAS flow /permissions approve uses.
    const snap = await store.read("ws-1");
    expect(snap.policy.capabilities).toEqual([{ kind: "commit-file", path: "/p/a.txt" }]);
    // Retained in the long-lived active set for the rest of the session.
    expect(lifecycle.getActiveCapabilities()).toEqual([{ kind: "commit-file", path: "/p/a.txt" }]);
  });

  it("global approval persists under the global workspace identity", async () => {
    const store = new LocalPolicyStore({ root: dir });
    const lifecycle = new ActionLifecycle({
      policy: new PolicyEngine("digest"),
      policyContext: approvalContext("ws-1"),
      broker: {
        mode: "inline",
        request: async (req) => approved(req, "user", "global"),
      },
      boundary: fakeBoundary({ output: "ok", success: true }),
      audit: new LocalAuditStore({ root: dir }),
      activeCapabilities: { capabilities: [] },
      policyStore: store,
      workspaceId: "ws-1",
      terminalOutbox: { enqueue: async () => {} },
    });
    const result = await lifecycle.run(writeAction());
    expect(result.outcome.state).toBe("succeeded");
    const snap = await store.read(GLOBAL_WORKSPACE_ID);
    expect(snap.policy.capabilities).toEqual([{ kind: "commit-file", path: "/p/a.txt" }]);
    // The project store stays untouched.
    const projectSnap = await store.read("ws-1");
    expect(projectSnap.policy.capabilities).toEqual([]);
  });

  it("a persistent selection without the protected store is denied, zero dispatches", async () => {
    let dispatched = false;
    const lifecycle = new ActionLifecycle({
      policy: new PolicyEngine("digest"),
      policyContext: approvalContext("ws-1"),
      broker: {
        mode: "inline",
        request: async (req) => approved(req, "user", "project"),
      },
      boundary: {
        capabilities: LOCAL_BACKEND,
        async execute() {
          dispatched = true;
          return { state: "succeeded", result: { output: "x", success: true }, evidence: { backend: "local-native", actionDigest: "d", executorId: "t", operationKind: "commit-files" } };
        },
      },
      audit: new LocalAuditStore({ root: dir }),
      activeCapabilities: { capabilities: [] },
      // No policyStore on purpose.
    });
    const result = await lifecycle.run(writeAction());
    expect(result.outcome.state).toBe("denied");
    expect(result.decision.decision).toBe("needs-approval");
    expect(dispatched).toBe(false);
  });

  it("a store write failure denies with approval-unavailable, zero dispatches", async () => {
    let dispatched = false;
    const brokenStore: import("../../../foundations/contracts/execution-brokers.js").PolicyStore = {
      async read() {
        throw new Error("store unavailable");
      },
      async compareAndSet() {
        throw new Error("never reached");
      },
    };
    const lifecycle = new ActionLifecycle({
      policy: new PolicyEngine("digest"),
      policyContext: approvalContext("ws-1"),
      broker: {
        mode: "inline",
        request: async (req) => approved(req, "user", "global"),
      },
      boundary: {
        capabilities: LOCAL_BACKEND,
        async execute() {
          dispatched = true;
          return { state: "succeeded", result: { output: "x", success: true }, evidence: { backend: "local-native", actionDigest: "d", executorId: "t", operationKind: "commit-files" } };
        },
      },
      audit: new LocalAuditStore({ root: dir }),
      activeCapabilities: { capabilities: [] },
      policyStore: brokenStore,
      workspaceId: "ws-1",
    });
    const result = await lifecycle.run(writeAction());
    expect(result.outcome.state).toBe("denied");
    expect(dispatched).toBe(false);
  });
});

describe("persistent approval audit ordering (P0 review fix)", () => {
  it("durably records approved + policy-granted BEFORE the grant is usable, with versions and actor", async () => {
    const store = new LocalPolicyStore({ root: dir });
    const events: import("../../../foundations/contracts/execution-brokers.js").ActionAuditEvent[] = [];
    const recordingAudit: import("../../../foundations/contracts/execution-brokers.js").AuditStore = {
      async append(event) {
        events.push(event);
        return "written";
      },
      async getTerminal() {
        return undefined;
      },
    };
    const lifecycle = new ActionLifecycle({
      policy: new PolicyEngine("digest"),
      policyContext: policyCtx({
        deploymentCeiling: set({ kind: "commit-file", path: "/p/a.txt" }),
        principalPolicy: set({ kind: "commit-file", path: "/p/a.txt" }),
        activeCapabilities: set(),
        workspaceId: "ws-1",
      }),
      broker: {
        mode: "inline",
        request: async (req) => approved(req, "user-42", "project"),
      },
      boundary: fakeBoundary({ output: "ok", success: true }),
      audit: recordingAudit,
      activeCapabilities: { capabilities: [] },
      policyStore: store,
      workspaceId: "ws-1",
      terminalOutbox: { enqueue: async () => {} },
    });
    const result = await lifecycle.run(writeAction());
    expect(result.outcome.state).toBe("succeeded");
    const approvedEvent = events.find((e) => e.state === "approved");
    expect(approvedEvent).toBeDefined();
    expect(approvedEvent!.actorId).toBe("user-42");
    expect(approvedEvent!.optionId).toBeDefined();
    expect(approvedEvent!.lifetime).toBe("project");
    expect(approvedEvent!.capabilities).toEqual([{ kind: "commit-file", path: "/p/a.txt" }]);
    expect(approvedEvent!.policyBeforeVersion).toBe(0);
    expect(approvedEvent!.grantedWorkspaceId).toBe("ws-1");
    const grantedEvent = events.find((e) => e.state === "policy-granted");
    expect(grantedEvent).toBeDefined();
    expect(grantedEvent!.policyAfterVersion).toBe(1);
    // The approved event precedes the policy-granted event.
    expect(events.indexOf(approvedEvent!)).toBeLessThan(events.indexOf(grantedEvent!));
    const snap = await store.read("ws-1");
    expect(snap.version).toBe(1);
    expect(snap.grantedBy?.authorityId).toBe("inline-approval");
  });

  it("an audit failure BEFORE the CAS installs NO authority", async () => {
    const store = new LocalPolicyStore({ root: dir });
    const brokenAudit: import("../../../foundations/contracts/execution-brokers.js").AuditStore = {
      async append(event) {
        // Fail ONLY on the grant records — prepared/awaiting/denied must
        // succeed so the failure lands exactly at the pre-CAS audit.
        if (event.state === "approved" || event.state === "policy-granted") {
          throw new Error("audit down");
        }
        return "written";
      },
      async getTerminal() {
        return undefined;
      },
    };
    const lifecycle = new ActionLifecycle({
      policy: new PolicyEngine("digest"),
      policyContext: policyCtx({
        deploymentCeiling: set({ kind: "commit-file", path: "/p/a.txt" }),
        principalPolicy: set({ kind: "commit-file", path: "/p/a.txt" }),
        activeCapabilities: set(),
        workspaceId: "ws-1",
      }),
      broker: {
        mode: "inline",
        request: async (req) => approved(req, "user", "global"),
      },
      boundary: fakeBoundary({ output: "ok", success: true }),
      audit: brokenAudit,
      activeCapabilities: { capabilities: [] },
      policyStore: store,
      workspaceId: "ws-1",
      terminalOutbox: { enqueue: async () => {} },
    });
    const result = await lifecycle.run(writeAction());
    expect(result.outcome.state).toBe("denied");
    // Nothing was installed — the global store is untouched.
    const snap = await store.read(GLOBAL_WORKSPACE_ID);
    expect(snap.policy.capabilities).toEqual([]);
    expect(snap.version).toBe(0);
  });
});

describe("active-authority revocation (P1 review fix)", () => {
  it("revokeActiveCapabilities removes matching authority from the live set immediately", () => {
    const lifecycle = new ActionLifecycle({
      policy: new PolicyEngine("digest"),
      policyContext: policyCtx({
        deploymentCeiling: set({ kind: "commit-file", path: "/p/a.txt" }),
        principalPolicy: set({ kind: "commit-file", path: "/p/a.txt" }),
        activeCapabilities: set({ kind: "commit-file", path: "/p/a.txt" }),
        workspaceId: "ws-1",
      }),
      broker: fakeBroker({ approved: false, requestId: "", actionDigest: "", actorId: "u", decidedAt: 0 }),
      boundary: fakeBoundary({ output: "ok", success: true }),
      audit: new LocalAuditStore({ root: dir }),
      activeCapabilities: { capabilities: [{ kind: "commit-file", path: "/p/a.txt" }] },
    });
    expect(lifecycle.getActiveCapabilities()).toHaveLength(1);
    lifecycle.revokeActiveCapabilities([{ kind: "commit-file", path: "/p/a.txt" }]);
    expect(lifecycle.getActiveCapabilities()).toEqual([]);
    // The policy context's view is the same live set.
    expect(lifecycle.getActiveCapabilities()).toEqual([]);
  });

  it("revokeActiveCapabilities leaves unrelated authority untouched", () => {
    const lifecycle = new ActionLifecycle({
      policy: new PolicyEngine("digest"),
      policyContext: policyCtx({
        deploymentCeiling: set({ kind: "commit-file", path: "/p/a.txt" }),
        principalPolicy: set({ kind: "commit-file", path: "/p/a.txt" }),
        activeCapabilities: set(),
        workspaceId: "ws-1",
      }),
      broker: fakeBroker({ approved: false, requestId: "", actionDigest: "", actorId: "u", decidedAt: 0 }),
      boundary: fakeBoundary({ output: "ok", success: true }),
      audit: new LocalAuditStore({ root: dir }),
      activeCapabilities: { capabilities: [{ kind: "commit-file", path: "/p/a.txt" }, { kind: "commit-file", path: "/p/other.txt" }] },
    });
    lifecycle.revokeActiveCapabilities([{ kind: "commit-file", path: "/p/a.txt" }]);
    expect(lifecycle.getActiveCapabilities()).toEqual([{ kind: "commit-file", path: "/p/other.txt" }]);
  });
});

describe("persistent grant WAL (round 4 P0 review fix)", () => {
  it("audit AND outbox double failure denies with NOTHING installed", async () => {
    const store = new LocalPolicyStore({ root: dir });
    const audit: import("../../../foundations/contracts/execution-brokers.js").AuditStore = {
      async append(event) {
        if (event.state === "policy-granted") throw new Error("audit down");
        return "written";
      },
      async getTerminal() {
        return undefined;
      },
    };
    const outbox: { enqueue: () => Promise<void> } = {
      async enqueue() {
        throw new Error("outbox disk full");
      },
    };
    const lifecycle = new ActionLifecycle({
      policy: new PolicyEngine("digest"),
      policyContext: policyCtx({
        deploymentCeiling: set({ kind: "commit-file", path: "/p/a.txt" }),
        principalPolicy: set({ kind: "commit-file", path: "/p/a.txt" }),
        activeCapabilities: set(),
        workspaceId: "ws-1",
      }),
      broker: {
        mode: "inline",
        request: async (req) => approved(req, "user", "project"),
      },
      boundary: fakeBoundary({ output: "ok", success: true }),
      audit,
      activeCapabilities: { capabilities: [] },
      policyStore: store,
      workspaceId: "ws-1",
      terminalOutbox: outbox,
    });
    const result = await lifecycle.run(writeAction());
    expect(result.outcome.state).toBe("denied");
    // The reviewer's probe: denial must NOT leave authority installed.
    const snap = await store.read("ws-1");
    expect(snap.policy.capabilities).toEqual([]);
    expect(snap.version).toBe(0);
  });

  it("a post-CAS audit failure is covered by the durable WAL intent", async () => {
    const store = new LocalPolicyStore({ root: dir });
    const audit: import("../../../foundations/contracts/execution-brokers.js").AuditStore = {
      async append(event) {
        // approved succeeds; policy-granted fails; the pre-CAS durable
        // intent is enqueued (outbox works), so the WAL covers the record
        // even though the direct append fails.
        if (event.state === "policy-granted") throw new Error("audit down");
        return "written";
      },
      async getTerminal() {
        return undefined;
      },
    };
    let enqueued = 0;
    const outbox: { enqueue: () => Promise<void> } = {
      async enqueue() {
        enqueued++;
      },
    };
    const lifecycle = new ActionLifecycle({
      policy: new PolicyEngine("digest"),
      policyContext: policyCtx({
        deploymentCeiling: set({ kind: "commit-file", path: "/p/a.txt" }),
        principalPolicy: set({ kind: "commit-file", path: "/p/a.txt" }),
        activeCapabilities: set(),
        workspaceId: "ws-1",
      }),
      broker: {
        mode: "inline",
        request: async (req) => approved(req, "user", "project"),
      },
      boundary: fakeBoundary({ output: "ok", success: true }),
      audit,
      activeCapabilities: { capabilities: [] },
      policyStore: store,
      workspaceId: "ws-1",
      terminalOutbox: outbox,
    });
    const result = await lifecycle.run(writeAction());
    // The durable intent was written (WAL) before the CAS: execution
    // proceeds and the outbox delivers the forensic record.
    expect(enqueued).toBe(1);
    expect(result.outcome.state).toBe("succeeded");
    const snap = await store.read("ws-1");
    expect(snap.policy.capabilities).toEqual([{ kind: "commit-file", path: "/p/a.txt" }]);
  });
});

describe("persistent grant WAL — concurrent flush, CAS failure, recovery (round 5 P0)", () => {
  /** Persistent-grant lifecycle over the REAL outbox + audit store. */
  function walLifecycle(opts: {
    store: LocalPolicyStore;
    audit: LocalAuditStore;
    outbox: TerminalEventOutbox;
    lifetime: "project" | "global";
  }): ActionLifecycle {
    return new ActionLifecycle({
      policy: new PolicyEngine("digest"),
      policyContext: policyCtx({
        deploymentCeiling: set({ kind: "commit-file", path: "/p/a.txt" }),
        principalPolicy: set({ kind: "commit-file", path: "/p/a.txt" }),
        activeCapabilities: set(),
        workspaceId: "ws-1",
      }),
      broker: {
        mode: "inline",
        request: async (req) => approved(req, "user", opts.lifetime),
      },
      boundary: fakeBoundary({ output: "ok", success: true }),
      audit: opts.audit,
      activeCapabilities: { capabilities: [] },
      policyStore: opts.store,
      workspaceId: "ws-1",
      terminalOutbox: opts.outbox,
    });
  }

  it("a concurrent outbox flush between intent and CAS produces BOTH records (no duplicate collision)", async () => {
    const audit = new LocalAuditStore({ root: dir });
    const outbox = new TerminalEventOutbox(audit);
    const store = new LocalPolicyStore({ root: join(dir, "policy") });
    // Simulate the reviewer's race: the shared background outbox flushes the
    // intent BEFORE the CAS completes.
    const originalCas = store.compareAndSet.bind(store);
    store.compareAndSet = (async (...args: Parameters<LocalPolicyStore["compareAndSet"]>) => {
      await outbox.flush();
      return originalCas(...args);
    }) as LocalPolicyStore["compareAndSet"];
    const lifecycle = walLifecycle({ store, audit, outbox, lifetime: "project" });
    const result = await lifecycle.run(writeAction());
    expect(result.outcome.state).toBe("succeeded");
    await outbox.flush();
    const events = await audit.listEvents();
    // Distinct states and distinct idempotency keys: the flushed intent and
    // the committed record coexist; the committed record has the version.
    const intents = events.filter((e) => e.state === "policy-grant-intent");
    const committed = events.filter((e) => e.state === "policy-granted");
    expect(intents).toHaveLength(1);
    expect(intents[0].policyAfterVersion).toBeUndefined();
    expect(committed).toHaveLength(1);
    expect(committed[0].policyAfterVersion).toBe(1);
    const snap = await store.read("ws-1");
    expect(snap.policy.capabilities).toEqual([{ kind: "commit-file", path: "/p/a.txt" }]);
  });

  it("a CAS failure leaves a provisional intent and denies with nothing installed", async () => {
    const audit = new LocalAuditStore({ root: dir });
    const outbox = new TerminalEventOutbox(audit);
    const store = new LocalPolicyStore({ root: join(dir, "policy") });
    const originalCas = store.compareAndSet.bind(store);
    let calls = 0;
    store.compareAndSet = (async (...args: Parameters<LocalPolicyStore["compareAndSet"]>) => {
      calls++;
      throw new Error("policy store down");
    }) as LocalPolicyStore["compareAndSet"];
    void originalCas;
    const lifecycle = walLifecycle({ store, audit, outbox, lifetime: "global" });
    const result = await lifecycle.run(writeAction());
    expect(result.outcome.state).toBe("denied");
    expect(calls).toBeGreaterThan(0);
    const snap = await store.read(GLOBAL_WORKSPACE_ID);
    expect(snap.policy.capabilities).toEqual([]);
    // The durable intent remains as the provisional trail; reconciliation
    // will see the store never advanced and leave it as-is.
    await outbox.flush();
    const events = await audit.listEvents();
    expect(events.filter((e) => e.state === "policy-grant-intent")).toHaveLength(1);
    expect(events.filter((e) => e.state === "policy-granted")).toHaveLength(0);
  });
});

describe("WAL startup reconciliation (round 5 P0)", () => {
  it("an intent whose CAS committed is completed with the missing committed record", async () => {
    const audit = new LocalAuditStore({ root: dir });
    const store = new LocalPolicyStore({ root: join(dir, "policy") });
    // Simulate a crash AFTER the CAS but BEFORE the committed append: the
    // store already contains the grant and the audit holds only the intent.
    await store.compareAndSet(
      "ws-1",
      0,
      { version: 1, capabilities: [{ kind: "commit-file", path: "/p/a.txt" }] },
      { kind: "human", authorityId: "inline-approval", authenticatedBy: "tui" },
      { mutationId: "mut-1" },
    );
    await audit.append(
      {
        eventId: "intent-1",
        actionId: "a1",
        actionDigest: "d1",
        principalId: "user",
        runId: "r1",
        state: "policy-grant-intent",
        timestamp: 1,
        policyDigest: "digest",
        optionId: "opt-1",
        lifetime: "project",
        capabilities: [{ kind: "commit-file", path: "/p/a.txt" }],
        actorId: "user",
        policyBeforeVersion: 0,
        grantedWorkspaceId: "ws-1",
        mutationId: "mut-1",
      },
      { idempotencyKey: "a1:policy-grant-intent" },
    );
    // Rebuilding the pipeline runs the reconciliation.
    await buildActionLifecycle({
      principalId: "user",
      runId: "r1",
      sessionId: "s1",
      workspaceRoot: dir,
      approvalBroker: { mode: "none" as const, request: async () => ({ approved: false, requestId: "x", actionDigest: "y", actorId: "u", decidedAt: 0 }) },
      executionBoundary: fakeBoundary({ output: "ok", success: true }),
      auditStore: audit,
      policyStore: store,
    });
    const events = await audit.listEvents();
    const committed = events.filter((e) => e.state === "policy-granted" && e.actionId === "a1");
    expect(committed).toHaveLength(1);
    expect(committed[0].policyAfterVersion).toBe(1);
    expect(committed[0].policyBeforeVersion).toBe(0);
  });

  it("an intent whose CAS never committed stays provisional", async () => {
    const audit = new LocalAuditStore({ root: dir });
    const store = new LocalPolicyStore({ root: join(dir, "policy") });
    // Intent only — the store never advanced.
    await audit.append(
      {
        eventId: "intent-2",
        actionId: "a2",
        actionDigest: "d2",
        principalId: "user",
        runId: "r1",
        state: "policy-grant-intent",
        timestamp: 1,
        policyDigest: "digest",
        optionId: "opt-1",
        lifetime: "project",
        capabilities: [{ kind: "commit-file", path: "/p/a.txt" }],
        actorId: "user",
        policyBeforeVersion: 0,
        grantedWorkspaceId: "ws-1",
      },
      { idempotencyKey: "a2:policy-grant-intent" },
    );
    await buildActionLifecycle({
      principalId: "user",
      runId: "r1",
      sessionId: "s1",
      workspaceRoot: dir,
      approvalBroker: { mode: "none" as const, request: async () => ({ approved: false, requestId: "x", actionDigest: "y", actorId: "u", decidedAt: 0 }) },
      executionBoundary: fakeBoundary({ output: "ok", success: true }),
      auditStore: audit,
      policyStore: store,
    });
    const events = await audit.listEvents();
    expect(events.filter((e) => e.state === "policy-granted" && e.actionId === "a2")).toHaveLength(0);
    expect(events.filter((e) => e.state === "policy-grant-intent" && e.actionId === "a2")).toHaveLength(1);
  });
});

describe("strict request binding (round 4/5 P1/P2)", () => {
  const makeLifecycle = (decision: (req: PermissionRequest) => PermissionDecision): ActionLifecycle => {
    return new ActionLifecycle({
      policy: new PolicyEngine("digest"),
      policyContext: policyCtx({
        deploymentCeiling: set({ kind: "commit-file", path: "/p/a.txt" }),
        principalPolicy: set({ kind: "commit-file", path: "/p/a.txt" }),
        activeCapabilities: set(),
      }),
      broker: { mode: "inline", request: async (req) => decision(req) },
      boundary: fakeBoundary({ output: "ok", success: true }),
      audit: new LocalAuditStore({ root: dir }),
      activeCapabilities: { capabilities: [] },
    });
  };

  it("an approved decision WITHOUT requestId is rejected", async () => {
    const lifecycle = makeLifecycle((req) => {
      const d = approved(req, "user", "action");
      return { ...d, requestId: undefined as never };
    });
    const result = await lifecycle.run(writeAction());
    expect(result.outcome.state).toBe("denied");
    expect(result.approval?.approved).toBe(true);
  });

  it("an approved decision WITHOUT actionDigest is rejected", async () => {
    const lifecycle = makeLifecycle((req) => {
      const d = approved(req, "user", "action");
      return { ...d, actionDigest: undefined as never };
    });
    const result = await lifecycle.run(writeAction());
    expect(result.outcome.state).toBe("denied");
  });

  it("an approved decision WITHOUT an explicit lifetime is rejected (no silent action default)", async () => {
    const lifecycle = makeLifecycle((req) => {
      const d = approved(req, "user", "action");
      return { ...d, lifetime: undefined as never };
    });
    const result = await lifecycle.run(writeAction());
    expect(result.outcome.state).toBe("denied");
  });
});

describe("WAL restart + mutation-ID binding (round 6 P0)", () => {
  it("a crashed process's PENDING outbox file is reloaded, flushed, and reconciled after restart", async () => {
    const realSecurityDir = process.env.SEEPIENT_SECURITY_DIR;
    const securityDir = join(dir, "security-dir");
    process.env.SEEPIENT_SECURITY_DIR = securityDir;
    try {
      const audit = new LocalAuditStore({ root: join(dir, "audit") });
      const store = new LocalPolicyStore({ root: join(dir, "policy") });
      // Simulate the crashed process: its outbox enqueued (and PERSISTED to
      // pending.<pid>.ndjson) the durable intent, and the CAS installed the
      // grant with the SAME mutation ID — then the process died before the
      // committed append and before any flush.
      const crashedOutbox = new TerminalEventOutbox(audit);
      const mutationId = "mut-crash-1";
      await crashedOutbox.enqueue(
        {
          eventId: "intent-crash-1",
          actionId: "a-crash",
          actionDigest: "d-crash",
          principalId: "user-A",
          runId: "r1",
          state: "policy-grant-intent",
          timestamp: 1,
          policyDigest: "digest",
          optionId: "opt-1",
          lifetime: "project",
          capabilities: [{ kind: "commit-file", path: "/p/a.txt" }],
          actorId: "user-A",
          policyBeforeVersion: 0,
          grantedWorkspaceId: "ws-1",
          mutationId,
        },
        "a-crash:policy-grant-intent",
      );
      await store.compareAndSet(
        "ws-1",
        0,
        { version: 1, capabilities: [{ kind: "commit-file", path: "/p/a.txt" }] },
        { kind: "human", authorityId: "inline-approval", authenticatedBy: "tui" },
        { mutationId },
      );
      // "Restart": a fresh pipeline. The factory creates a NEW outbox which
      // must reload the crashed process's pending file, flush it to the
      // audit, and reconcile the intent against the store's mutation ID.
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
      const events = await audit.listEvents();
      const committed = events.filter((e) => e.state === "policy-granted" && e.actionId === "a-crash");
      expect(committed).toHaveLength(1);
      expect(committed[0].mutationId).toBe(mutationId);
      expect(committed[0].policyAfterVersion).toBe(1);
    } finally {
      if (realSecurityDir === undefined) delete process.env.SEEPIENT_SECURITY_DIR;
      else process.env.SEEPIENT_SECURITY_DIR = realSecurityDir;
    }
  });

  it("does NOT fabricate a committed record when a DIFFERENT action granted the same capability", async () => {
    const audit = new LocalAuditStore({ root: dir });
    const store = new LocalPolicyStore({ root: join(dir, "policy") });
    // The store was mutated by action-B with ITS OWN mutation ID.
    await store.compareAndSet(
      "ws-1",
      0,
      { version: 1, capabilities: [{ kind: "commit-file", path: "/p/a.txt" }] },
      { kind: "human", authorityId: "operator", authenticatedBy: "cli" },
      { mutationId: "mut-action-B" },
    );
    // Action-A's intent carries a DIFFERENT mutation ID.
    await audit.append(
      {
        eventId: "intent-A",
        actionId: "action-A",
        actionDigest: "dA",
        principalId: "user-A",
        runId: "r1",
        state: "policy-grant-intent",
        timestamp: 1,
        policyDigest: "digest",
        optionId: "opt-1",
        lifetime: "project",
        capabilities: [{ kind: "commit-file", path: "/p/a.txt" }],
        actorId: "user-A",
        policyBeforeVersion: 0,
        grantedWorkspaceId: "ws-1",
        mutationId: "mut-action-A",
      },
      { idempotencyKey: "action-A:policy-grant-intent" },
    );
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
    const events = await audit.listEvents();
    // No committed record may be fabricated for action-A.
    expect(events.filter((e) => e.state === "policy-granted" && e.actionId === "action-A")).toHaveLength(0);
    expect(events.filter((e) => e.state === "policy-grant-intent" && e.actionId === "action-A")).toHaveLength(1);
  });
});

describe("multi-mutation WAL history (round 7 P0)", () => {
  const cap = { kind: "commit-file" as const, path: "/p/a.txt" };
  const actor = { kind: "human" as const, authorityId: "inline-approval", authenticatedBy: "tui" };
  const intentEvent = (id: string, actionId: string, mutationId: string, beforeVersion: number) => ({
    eventId: `intent-${id}`,
    actionId,
    actionDigest: `d-${id}`,
    principalId: `user-${id}`,
    runId: "r1",
    state: "policy-grant-intent" as const,
    timestamp: 1,
    policyDigest: "digest",
    optionId: "opt-1",
    lifetime: "project" as const,
    capabilities: [cap],
    actorId: `user-${id}`,
    policyBeforeVersion: beforeVersion,
    grantedWorkspaceId: "ws-1",
    mutationId,
  });

  it("TWO successful mutations, both missing their committed appends, are BOTH finalized after restart", async () => {
    const audit = new LocalAuditStore({ root: dir });
    const store = new LocalPolicyStore({ root: join(dir, "policy") });
    // Both CAS operations completed (the lifecycle's exact shape: each
    // appends to the mutation history), but the processes crashed before
    // either committed append.
    await store.compareAndSet(
      "ws-1", 0,
      { version: 1, capabilities: [cap] },
      actor,
      { mutationId: "mut-A" },
    );
    await store.compareAndSet(
      "ws-1", 1,
      { version: 1, capabilities: [cap] },
      actor,
      { mutationId: "mut-B" },
    );
    await audit.append(intentEvent("A", "action-A", "mut-A", 0), { idempotencyKey: "action-A:policy-grant-intent" });
    await audit.append(intentEvent("B", "action-B", "mut-B", 1), { idempotencyKey: "action-B:policy-grant-intent" });
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
    const events = await audit.listEvents();
    const committedA = events.filter((e) => e.state === "policy-granted" && e.actionId === "action-A");
    const committedB = events.filter((e) => e.state === "policy-granted" && e.actionId === "action-B");
    // Both finalized — the mutation history proves each mutation.
    expect(committedA).toHaveLength(1);
    expect(committedA[0].mutationId).toBe("mut-A");
    expect(committedA[0].policyAfterVersion).toBe(1);
    expect(committedB).toHaveLength(1);
    expect(committedB[0].mutationId).toBe("mut-B");
    expect(committedB[0].policyAfterVersion).toBe(2);
  });

  it("an intent WITHOUT a mutation ID is never auto-committed (stays provisional)", async () => {
    const audit = new LocalAuditStore({ root: dir });
    const store = new LocalPolicyStore({ root: join(dir, "policy") });
    await store.compareAndSet(
      "ws-1", 0,
      { version: 1, capabilities: [cap] },
      actor,
      { mutationId: "mut-B" },
    );
    const legacy = intentEvent("legacy", "action-legacy", "mut-legacy", 0);
    await audit.append({ ...legacy, mutationId: undefined as never }, { idempotencyKey: "action-legacy:policy-grant-intent" });
    await buildActionLifecycle({
      principalId: "user-legacy",
      runId: "r1",
      sessionId: "s1",
      workspaceRoot: dir,
      approvalBroker: { mode: "none" as const, request: async () => ({ approved: false, requestId: "x", actionDigest: "y", actorId: "u", decidedAt: 0 }) },
      executionBoundary: fakeBoundary({ output: "ok", success: true }),
      auditStore: audit,
      policyStore: store,
    });
    const events = await audit.listEvents();
    expect(events.filter((e) => e.state === "policy-granted" && e.actionId === "action-legacy")).toHaveLength(0);
    expect(events.filter((e) => e.state === "policy-grant-intent" && e.actionId === "action-legacy")).toHaveLength(1);
  });

  it("a non-journal admin mutation cannot fabricate a committed record for an unrelated intent", async () => {
    const audit = new LocalAuditStore({ root: dir });
    const store = new LocalPolicyStore({ root: join(dir, "policy") });
    // The admin flow's CAS carries NO mutationId and NO history.
    await store.compareAndSet(
      "ws-1", 0,
      { version: 1, capabilities: [cap] },
      { kind: "human" as const, authorityId: "operator", authenticatedBy: "cli" },
    );
    await audit.append(intentEvent("A", "action-A", "mut-A", 0), { idempotencyKey: "action-A:policy-grant-intent" });
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
    const events = await audit.listEvents();
    // Version advanced and the capability is present, but the store has no
    // history entry for mut-A: the intent stays provisional.
    expect(events.filter((e) => e.state === "policy-granted" && e.actionId === "action-A")).toHaveLength(0);
  });
});

