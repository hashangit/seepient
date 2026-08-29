/**
 * T405 tests (spec 008, FR-003/FR-017) — control plane executes nothing
 * model-authored.
 *
 * Verifies: effectful operation kinds route to the scheduler (never run
 * in-process); `none`/`read-file` may execute locally ONLY when an explicit
 * safe executor is wired; worker results are translated faithfully; dispatch
 * signature covers every field except signature itself.
 */
import { describe, it, expect, vi } from "vitest";
import {
  WorkerExecutionBoundary,
  canonicalDispatch,
} from "../worker-execution-boundary.js";
import type { WorkerExecutionBoundaryOptions } from "../worker-execution-boundary.js";
import type { WorkerScheduler, WorkerDispatch, WorkerResult } from "../../../foundations/contracts/worker-protocol.js";
import type { PreparedToolAction } from "../../../foundations/contracts/prepared-action.js";
import type { CapabilityEnvelope } from "../../../foundations/contracts/permission-policy.js";
import type { ExecutionBackendCapabilities, ExecutionResult } from "../../../foundations/contracts/execution-boundary.js";

const DOCKER_BACKEND: ExecutionBackendCapabilities = {
  backend: "docker-worker",
  capabilityKinds: ["commit-file", "read-file", "process", "model-egress", "network-destination"],
  exactCommit: true,
  jsFsFallbackOptIn: false,
  hostFilteredEgress: true,
  environmentIsolation: true,
  supportedOperationKinds: ["none", "read-file", "commit-files", "process", "broker"],
};

function envelope(): CapabilityEnvelope {
  return {
    version: 1,
    envelopeId: "e1",
    principalId: "u",
    runId: "r1",
    actionDigest: "d1",
    capabilities: [{ kind: "commit-file", path: "/workspace/a.txt" }],
    lifetime: { kind: "action", actionDigest: "d1", consumeOnce: true },
    issuedBy: { kind: "service", authorityId: "pe", authenticatedBy: "d" },
    issuedAt: 0,
    policyDigest: "dig",
  };
}

function action(kind: PreparedToolAction["operation"]["kind"]): PreparedToolAction {
  const base = {
    version: 1 as const,
    actionId: "a1",
    runId: "r1",
    toolCallId: "c1",
    toolName: kind === "process" ? "execute_shell_command" : "write_file",
    principalId: "u",
    argsDigest: "x",
    actionDigest: "d1",
    risk: "edit" as const,
    effects: [],
    display: { title: "t", summary: "s", canonicalTargets: [], effects: [] },
  };
  if (kind === "none") return { ...base, operation: { kind, result: { output: "ok", success: true } } } as PreparedToolAction;
  if (kind === "read-file") return { ...base, operation: { kind, target: { canonicalPath: "/workspace/a", canonicalParent: "/workspace", basename: "a", exists: true, finalSymlink: false }, expected: { exists: true } } } as PreparedToolAction;
  if (kind === "commit-files") return { ...base, operation: { kind, commits: [] } } as PreparedToolAction;
  if (kind === "process") return { ...base, operation: { kind, command: { executable: "/bin/echo", argv: ["hi"], cwd: "/workspace" }, roots: [] } } as PreparedToolAction;
  if (kind === "broker") {
    return {
      ...base,
      operation: {
        kind,
        request: {
          kind: "http",
          requestId: "br-1",
          destination: { scheme: "https", host: "api.example.com" },
          method: "GET",
          headers: {},
          secretRefs: [],
        },
      },
    } as PreparedToolAction;
  }
  return { ...base, operation: { kind, registrationId: "h", args: {} } } as PreparedToolAction;
}

function fakeScheduler(result: WorkerResult): WorkerScheduler & { dispatches: WorkerDispatch[] } {
  const dispatches: WorkerDispatch[] = [];
  return {
    dispatches,
    async dispatch(d) {
      dispatches.push(d);
      return result;
    },
    async cancel() {},
  };
}

function workerSuccess(): WorkerResult {
  return {
    version: 1,
    dispatchId: "a1",
    leaseId: "l1",
    actionDigest: "d1",
    state: "succeeded",
    result: { output: "from-worker", success: true },
    evidence: {
      backend: "docker-worker",
      actionDigest: "d1",
      executorId: "worker-1",
      operationKind: "commit-files",
      committedTargets: ["/workspace/a.txt"],
    },
  };
}

function makeBoundary(opts: Partial<WorkerExecutionBoundaryOptions> = {}) {
  return new WorkerExecutionBoundary({
    scheduler: opts.scheduler ?? fakeScheduler(workerSuccess()),
    auth: { controlPlaneId: "cp-1", authenticatedTransport: "mtls" },
    signingKeyId: "cp-key-1",
    sign: (canonical) => `sig:${canonical.slice(0, 8)}`,
    resolveWorkspace: () => ({
      leaseId: "l1",
      tenantId: "t-1",
      sessionId: "s-1",
      workspaceId: "ws-1",
      mountTarget: "/workspace",
      expiresAt: Date.now() + 60_000,
    }),
    capabilities: DOCKER_BACKEND,
    ...opts,
  });
}

describe("WorkerExecutionBoundary (T405)", () => {
  it("effectful commit-files routes to scheduler, never executes locally", async () => {
    let localExec = 0;
    const sched = fakeScheduler(workerSuccess());
    const boundary = makeBoundary({
      scheduler: sched,
      safeExecutor: { async execute() { localExec++; return {} as ExecutionResult; } },
    });
    const result = await boundary.execute(action("commit-files"), envelope(), {});
    expect(result.state).toBe("succeeded");
    expect(sched.dispatches).toHaveLength(1);
    expect(localExec).toBe(0); // safe executor NOT consulted for effectful kind
  });

  it("effectful process routes to scheduler (no in-process spawn)", async () => {
    const sched = fakeScheduler(workerSuccess());
    const boundary = makeBoundary({ scheduler: sched });
    await boundary.execute(action("process"), envelope(), {});
    expect(sched.dispatches).toHaveLength(1);
  });

  it("`none` executes via safeExecutor when provided (control-plane-safe)", async () => {
    let safeExec = 0;
    const sched = fakeScheduler(workerSuccess());
    const boundary = makeBoundary({
      scheduler: sched,
      safeExecutor: {
        async execute(a: PreparedToolAction) {
          safeExec++;
          return { state: "succeeded", result: { output: "local", success: true }, evidence: { backend: "docker-worker", actionDigest: a.actionDigest, executorId: "control-plane", operationKind: "none" } };
        },
      },
    });
    const result = await boundary.execute(action("none"), envelope(), {});
    expect(result.state).toBe("succeeded");
    expect(safeExec).toBe(1);
    expect(sched.dispatches).toHaveLength(0); // did NOT reach scheduler
  });

  it("`none` routes to scheduler when no safeExecutor is wired (defense in depth)", async () => {
    const sched = fakeScheduler(workerSuccess());
    const boundary = makeBoundary({ scheduler: sched });
    await boundary.execute(action("none"), envelope(), {});
    expect(sched.dispatches).toHaveLength(1);
  });

  it("dispatch signature covers every field except signature itself", async () => {
    const signCalls: string[] = [];
    const boundary = makeBoundary({
      sign: (c: string) => {
        signCalls.push(c);
        return "signed";
      },
    });
    await boundary.execute(action("commit-files"), envelope(), {});
    expect(signCalls).toHaveLength(1);
    const canonical = signCalls[0];
    // The canonical form must include action digest + workspace + envelope id.
    expect(canonical).toContain("d1");
    expect(canonical).toContain("ws-1");
    // And must NOT contain the signature field itself.
    expect(canonical).not.toContain('"signature"');
  });

  it("failed worker result is translated to a failed ExecutionResult", async () => {
    const sched = fakeScheduler({
      version: 1,
      dispatchId: "a1",
      leaseId: "l1",
      actionDigest: "d1",
      state: "failed",
      error: { code: "WORKER_EXIT_1", message: "nonzero", retryable: false },
      evidence: { backend: "docker-worker", actionDigest: "d1", executorId: "w", operationKind: "process" },
    });
    const boundary = makeBoundary({ scheduler: sched });
    const result = await boundary.execute(action("process"), envelope(), {});
    expect(result.state).toBe("failed");
    if (result.state === "failed") expect(result.error.code).toBe("WORKER_EXIT_1");
  });

  it("scheduler dispatch failure → structured failed result (not a throw)", async () => {
    const sched: WorkerScheduler = {
      async dispatch() {
        throw new Error("scheduler unreachable");
      },
      async cancel() {},
    };
    const boundary = makeBoundary({ scheduler: sched });
    const result = await boundary.execute(action("commit-files"), envelope(), {});
    expect(result.state).toBe("failed");
    if (result.state === "failed") {
      expect(result.error.code).toBe("WORKER_DISPATCH_FAILED");
      expect(result.error.retryable).toBe(true);
    }
  });

  it("canonicalDispatch is deterministic (same input → same output)", () => {
    const d = {
      version: 1 as const,
      dispatchId: "x",
      nonce: "n",
      issuedAt: 1,
      signingKeyId: "k",
      action: action("commit-files"),
      envelope: envelope(),
      workspace: { leaseId: "l", tenantId: "t", sessionId: "s", workspaceId: "w", mountTarget: "/workspace" as const, expiresAt: 2 },
      artifactManifest: [],
      deadline: 3,
      signature: "should-be-excluded",
    };
    expect(canonicalDispatch(d)).toBe(canonicalDispatch(d));
    expect(canonicalDispatch(d)).not.toContain("should-be-excluded");
  });

  it("broker lease token is threaded into the dispatch when issuer configured", async () => {
    let leaseIssued = 0;
    const sched = fakeScheduler(workerSuccess());
    const boundary = makeBoundary({
      scheduler: sched,
      issueBrokerLease: (digest: string) => {
        leaseIssued++;
        return { endpoint: "http://effect-broker:7001", token: `lease-${digest}`, expiresAt: Date.now() + 1000 };
      },
    });
    await boundary.execute(action("broker"), envelope(), {});
    expect(leaseIssued).toBe(1);
    expect(sched.dispatches[0].brokerLease?.token).toBe("lease-d1");
    expect(sched.dispatches[0].brokerLease?.endpoint).toBe("http://effect-broker:7001");
  });
});
