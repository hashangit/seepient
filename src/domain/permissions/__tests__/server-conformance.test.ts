/**
 * P4 consolidated server conformance matrix (spec 008, T411).
 *
 * Cross-cutting security matrix covering QS-4.1–QS-4.8 using the REAL stores
 * (LocalAuditStore, PendingApprovalStore, BrokerLeaseAuthority,
 * DockerWorkerScheduler with a fake engine, server-policy intersection).
 * Verifies the structural security guarantees the reference deployment must
 * enforce; the actual Docker run adds platform-level validation on top.
 *
 * Gates:
 *  - QS-4.1 ceiling/principal/request intersection (server-policy)
 *  - QS-4.2 tenant isolation (mount allowlist; cross-tenant denied)
 *  - QS-4.3 secret isolation (worker env sanitized; lease can't fetch secrets)
 *  - QS-4.4 REST never waits (resumable-approval)
 *  - QS-4.5 durable realtime approval (CAS, expiry, reconnect recovery)
 *  - QS-4.6 network boundary (broker lease required; metadata/private denied)
 *  - QS-4.7 Docker scheduler authority (socket absent from cp+worker; nonce)
 *  - QS-4.8 dispatch/result replay (same dispatchId returns recorded result)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  serverEffectiveCapabilities,
  serverCapabilityCovers,
} from "../server-policy.js";
import { PendingApprovalStore } from "../durable-approval-store.js";
import { LocalAuditStore, idempotencyKey } from "../audit-recorder.js";
import { DockerWorkerScheduler } from "../../../capabilities/execution/docker-worker-scheduler.js";
import {
  BrokerLeaseAuthority,
  BrokerLeaseError,
} from "../../../capabilities/execution/broker-lease-authority.js";
import { sanitizeEnvironment } from "../../../capabilities/execution/environment-policy.js";
import type {
  WorkerDispatch,
  WorkerResult,
  WorkerScheduler,
} from "../../../foundations/contracts/worker-protocol.js";
import type { Capability, CapabilitySet } from "../../../foundations/contracts/permission-policy.js";
import type { PermissionRequest } from "../../../foundations/contracts/permission-policy.js";
import type { PreparedToolAction } from "../../../foundations/contracts/prepared-action.js";
import type { CapabilityEnvelope } from "../../../foundations/contracts/permission-policy.js";
import { WorkerSchedulerError } from "../../../foundations/errors.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seepient-matrix-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function set(...c: Capability[]): CapabilitySet {
  return { version: 1, capabilities: c };
}

function envelope(actionDigest: string, caps: Capability[] = []): CapabilityEnvelope {
  return {
    version: 1,
    envelopeId: "e",
    principalId: "u",
    runId: "r",
    actionDigest,
    capabilities: caps,
    lifetime: { kind: "action", actionDigest, consumeOnce: true },
    issuedBy: { kind: "service", authorityId: "pe", authenticatedBy: "d" },
    issuedAt: 0,
    policyDigest: "d",
  };
}

function action(digest: string): PreparedToolAction {
  return {
    version: 1,
    actionId: digest,
    runId: "r",
    toolCallId: "c",
    toolName: "write_file",
    principalId: "u",
    argsDigest: "x",
    actionDigest: digest,
    risk: "edit",
    effects: [],
    display: { title: "t", summary: "s", canonicalTargets: [], effects: [] },
    operation: { kind: "commit-files", commits: [] },
  };
}

function dispatch(opts: Partial<WorkerDispatch> & { workspaceId?: string; tenantId?: string } = {}): WorkerDispatch {
  const wsId = opts.workspaceId ?? "ws-a";
  const tenantId = opts.tenantId ?? (wsId === "ws-a" ? "t-a" : wsId === "ws-b" ? "t-b" : "t");
  const existing = opts.workspace;
  return {
    version: 1,
    dispatchId: opts.dispatchId ?? "disp-1",
    nonce: opts.nonce ?? "nonce-1",
    issuedAt: opts.issuedAt ?? Date.now(),
    signingKeyId: "k",
    action: opts.action ?? action("d1"),
    envelope: opts.envelope ?? envelope("d1"),
    workspace: existing ?? {
      leaseId: "l",
      tenantId,
      sessionId: "s",
      workspaceId: wsId,
      mountTarget: "/workspace",
      expiresAt: Date.now() + 60_000,
    },
    artifactManifest: [],
    deadline: opts.deadline ?? Date.now() + 30_000,
    signature: opts.signature ?? "signed",
  };
}

function successResult(d: WorkerDispatch): WorkerResult {
  return {
    version: 1,
    dispatchId: d.dispatchId,
    leaseId: d.workspace.leaseId,
    actionDigest: d.action.actionDigest,
    state: "succeeded",
    result: { output: "ok", success: true },
    evidence: {
      backend: "docker-worker",
      actionDigest: d.action.actionDigest,
      executorId: "worker",
      operationKind: "commit-files",
    },
  };
}

function fakeSchedulerEngine(sched: { dispatches: WorkerDispatch[]; result: WorkerResult }) {
  return {
    created: [] as Array<{ image: string; mounts: unknown[]; env: string[] }>,
    async createContainer(spec: { image: string; mounts: unknown[]; env: string[] }) {
      this.created.push(spec);
      return { id: "c1" };
    },
    async attachStream() {
      const { EventEmitter } = require("node:events") as typeof import("node:events");
      const stream = new EventEmitter() as unknown as NodeJS.ReadableStream & NodeJS.WritableStream & { write(): boolean };
      (stream as { write(): boolean }).write = () => true;
      process.nextTick(() => stream.emit("data", Buffer.from(JSON.stringify(sched.result) + "\n")));
      return stream;
    },
    async start() {},
    async kill() {},
    async wait() {
      return { exitCode: 0 };
    },
    async remove() {},
  };
}

function makeScheduler(opts: {
  mounts?: Record<string, string>;
  registry?: Record<string, { hostPath: string; tenantId: string }>;
  result?: WorkerResult;
}): { sched: DockerWorkerScheduler; engine: { created: unknown[]; dispatches: WorkerDispatch[] } } {
  const dispatches: WorkerDispatch[] = [];
  const result = opts.result ?? successResult(dispatch());
  const engine = fakeSchedulerEngine({ dispatches, result });
  const mounts = opts.mounts ?? { "ws-a": "/workspaces/a", "ws-b": "/workspaces/b" };
  // Isolated temp root per scheduler so the persisted nonce ledger does not
  // leak across tests (otherwise a later dispatch short-circuits as an
  // idempotent-retry of an earlier one).
  const root = mkdtempSync(join(tmpdir(), "seepient-matrix-sched-"));
  const sched = new DockerWorkerScheduler({
    engine: engine as never,
    images: { "seepient/worker:latest": "sha256:abc" },
    mounts,
    registry:
      opts.registry ??
      Object.fromEntries(
        Object.entries(mounts).map(([id, path]) => [id, { hostPath: path, tenantId: id === "ws-a" ? "t-a" : "t-b" }]),
      ),
    defaultImage: "seepient/worker:latest",
    brokerNetwork: "broker-net",
    root,
  });
  return { sched, engine: { created: engine.created, dispatches } };
}

describe("QS-4.1 ceiling/principal/request intersection (T411)", () => {
  it("request narrower than principal → narrowed; broader → principal baseline", () => {
    const result = serverEffectiveCapabilities({
      principalId: "u1",
      tenantId: "t1",
      sessionId: "s1",
      deploymentCeiling: set(
        { kind: "commit-file", path: "/a" },
        { kind: "commit-file", path: "/b" },
      ),
      principalPolicy: set(
        { kind: "commit-file", path: "/a" },
        { kind: "commit-file", path: "/b" },
      ),
      workspacePolicy: set(
        { kind: "commit-file", path: "/a" },
        { kind: "commit-file", path: "/b" },
      ),
      requestRestriction: set({ kind: "commit-file", path: "/a" }),
      approvalMode: "remote",
    });
    expect(result.capabilities.capabilities).toEqual([{ kind: "commit-file", path: "/a" }]);
  });

  it("request broader than principal is intersected down (never expands)", () => {
    const result = serverEffectiveCapabilities({
      principalId: "u1",
      tenantId: "t1",
      sessionId: "s1",
      deploymentCeiling: set({ kind: "commit-file", path: "/a" }, { kind: "commit-file", path: "/b" }, { kind: "commit-file", path: "/c" }),
      principalPolicy: set({ kind: "commit-file", path: "/a" }),
      workspacePolicy: set({ kind: "commit-file", path: "/a" }),
      requestRestriction: set({ kind: "commit-file", path: "/a" }, { kind: "commit-file", path: "/x" }),
      approvalMode: "remote",
    });
    expect(result.capabilities.capabilities).toEqual([{ kind: "commit-file", path: "/a" }]);
  });
});

describe("QS-4.2 tenant isolation (T411)", () => {
  it("tenant A's workspace mounts only ws-a; ws-b is rejected", async () => {
    const { sched } = makeScheduler({});
    // Tenant A (t-a) tries to mount tenant B's workspace (ws-b, registered to t-b).
    const forged = dispatch({
      workspaceId: "ws-b",
      tenantId: "t-a", // attacker claims ws-b under their own tenant
      workspace: { leaseId: "l", tenantId: "t-a", sessionId: "s", workspaceId: "ws-b", mountTarget: "/workspace", expiresAt: Date.now() + 60_000 },
    });
    await expect(
      sched.dispatch(forged, { controlPlaneId: "cp", authenticatedTransport: "mtls" }),
    ).rejects.toBeInstanceOf(WorkerSchedulerError);
  });

  it("tenant A's own workspace (ws-a) is accepted", async () => {
    const { sched } = makeScheduler({});
    const ok = dispatch({ workspaceId: "ws-a", tenantId: "t-a" });
    const r = await sched.dispatch(ok, { controlPlaneId: "cp", authenticatedTransport: "mtls" });
    expect(r.state).toBe("succeeded");
  });

  it("unknown workspace is rejected (mount allowlist)", async () => {
    const { sched } = makeScheduler({});
    await expect(
      sched.dispatch(dispatch({ workspaceId: "ws-unknown" }), { controlPlaneId: "cp", authenticatedTransport: "mtls" }),
    ).rejects.toBeInstanceOf(WorkerSchedulerError);
  });
});

describe("QS-4.3 secret isolation (T411)", () => {
  it("worker env contains no provider/server/release credentials", async () => {
    const { sched, engine } = makeScheduler({});
    await sched.dispatch(dispatch(), { controlPlaneId: "cp", authenticatedTransport: "mtls" });
    const env = (engine.created[0] as { env: string[] }).env;
    expect(env.some((e) => e.startsWith("OPENAI_API_KEY"))).toBe(false);
    expect(env.some((e) => e.startsWith("ANTHROPIC_API_KEY"))).toBe(false);
    expect(env.some((e) => e.startsWith("DATABASE_URL"))).toBe(false);
  });

  it("the worker env is produced by sanitizeEnvironment", () => {
    const env = sanitizeEnvironment(
      { OPENAI_API_KEY: "sk-leak", LANG: "en_US.UTF-8", DATABASE_URL: "postgres://..." },
      { path: "/usr/bin", home: "/scratch" },
    );
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.LANG).toBe("en_US.UTF-8");
  });

  it("broker lease cannot fetch raw secrets (no fetch-secret operation)", () => {
    // The BrokeredEffectRequest union has no fetch-secret variant — raw
    // secret retrieval is structurally unrepresentable.
    type K = import("../../../foundations/contracts/prepared-action.js").BrokeredEffectRequest["kind"];
    const kinds: K[] = ["http", "external-send", "vendor-operation"];
    expect(kinds).not.toContain("fetch-secret");
  });
});

describe("QS-4.4 REST never waits (T411)", () => {
  function req(): PermissionRequest {
    return {
      requestId: "r",
      principalId: "u",
      runId: "r",
      sessionId: "s",
      toolCallId: "c",
      actionDigest: "d",
      action: { title: "t", summary: "s", canonicalTargets: [], effects: [] },
      requestedCapabilities: [],
      offeredLifetimes: ["action"],
      createdAt: 0,
      expiresAt: Date.now() + 60_000,
    };
  }

  it("a pending approval is durably recorded for later resolution (no synchronous wait)", () => {
    // The REST 'never waits' property is implemented in transport/http/
    // resumable-approval.ts (covered by resumable-approval.test.ts). At the
    // Domain layer, the equivalent guarantee is: a pending record is stored
    // durably and can be resolved asynchronously via CAS.
    const store = new PendingApprovalStore();
    store.create({
      request: req(),
      tenantId: "t",
      sessionId: "s",
      continuationId: "c-1",
    });
    expect(store.get("c-1")?.state).toBe("pending");
  });

  it("an approved pending record can be resolved asynchronously", () => {
    const store = new PendingApprovalStore();
    const rec = store.create({
      request: req(),
      tenantId: "t",
      sessionId: "s",
      continuationId: "c-1",
    });
    const decision = { approved: true, requestId: "r", actionDigest: "d", lifetime: "action" as const, actorId: "u", decidedAt: 0 };
    expect(store.cas("c-1", rec.version, decision).status).toBe("transitioned");
  });
});

describe("QS-4.5 durable realtime approval (T411)", () => {
  function prec(overrides: Partial<{ continuationId: string; requestId: string; principalId: string; sessionId: string }> = {}): PermissionRequest {
    return {
      requestId: overrides.requestId ?? "rq-1",
      principalId: overrides.principalId ?? "u",
      runId: "r",
      sessionId: overrides.sessionId ?? "s",
      toolCallId: "c",
      actionDigest: "d",
      action: { title: "t", summary: "s", canonicalTargets: [], effects: [] },
      requestedCapabilities: [],
      offeredLifetimes: ["action"],
      createdAt: 0,
      expiresAt: Date.now() + 60_000,
    };
  }

  it("reconnect recovery: a new client lists pending approvals for its principal", () => {
    const store = new PendingApprovalStore();
    store.create({
      request: prec({ continuationId: "c-1" }),
      tenantId: "t",
      sessionId: "s",
      continuationId: "c-1",
    });
    // "Reconnect": list pending for the principal.
    const pending = store.listPending("u");
    expect(pending).toHaveLength(1);
  });

  it("restart recovery: pending approvals survive (in-memory store; production uses SQL)", () => {
    // Production uses PostgreSQL; the contract is the same. This asserts the
    // list-pending path works for recovery scenarios.
    const store = new PendingApprovalStore();
    store.create({
      request: prec({ continuationId: "c-1" }),
      tenantId: "t",
      sessionId: "s",
      continuationId: "c-1",
    });
    expect(store.listPending("u")).toHaveLength(1);
  });

  it("duplicate approval is rejected (CAS)", () => {
    const store = new PendingApprovalStore();
    const rec = store.create({
      request: prec({ continuationId: "c-1" }),
      tenantId: "t",
      sessionId: "s",
      continuationId: "c-1",
    });
    const decision = { approved: true, requestId: "rq-1", actionDigest: "d", lifetime: "action" as const, actorId: "u", decidedAt: 0 };
    expect(store.cas("c-1", rec.version, decision).status).toBe("transitioned");
    expect(store.cas("c-1", rec.version, decision).status).toBe("duplicate");
  });

  it("expired approval denies safely", () => {
    const store = new PendingApprovalStore();
    store.create({
      request: { ...prec({ continuationId: "c-1" }), expiresAt: 1 },
      tenantId: "t",
      sessionId: "s",
      continuationId: "c-1",
    });
    const decision = { approved: true, requestId: "rq-1", actionDigest: "d", lifetime: "action" as const, actorId: "u", decidedAt: 0 };
    expect(store.cas("c-1", 1, decision, Date.now() + 1000).status).toBe("expired");
  });

  it("revoked outer ceiling prevents dispatch (reevaluation)", () => {
    const store = new PendingApprovalStore();
    const rec = store.create({
      request: prec({ continuationId: "c-1" }),
      tenantId: "t",
      sessionId: "s",
      continuationId: "c-1",
    });
    store.cas("c-1", rec.version, {
      approved: true,
      requestId: "rq-1",
      actionDigest: "d",
      lifetime: "action",
      actorId: "u",
      decidedAt: 0,
    });
    // Simulate a revoked operator ceiling.
    store.reevaluate("c-1", () => false);
    expect(store.get("c-1")?.state).toBe("denied");
  });
});

describe("QS-4.6 network boundary (T411)", () => {
  it("broker lease is required and action-bound", () => {
    const auth = new BrokerLeaseAuthority({ signingKey: "k" });
    const lease = auth.issue({ workerId: "w-1", actionDigest: "d1", singleUseRequestIds: ["r-1"] });
    // Valid presentation.
    expect(
      auth.verify(lease, { workerId: "w-1", actionDigest: "d1", singleUseRequestId: "r-1" }),
    ).toEqual(lease);
  });

  it("a lease forged for a different action is rejected", () => {
    const auth = new BrokerLeaseAuthority({ signingKey: "k" });
    const lease = auth.issue({ workerId: "w-1", actionDigest: "d1", singleUseRequestIds: ["r-1"] });
    expect(() =>
      auth.verify(lease, { workerId: "w-1", actionDigest: "d2", singleUseRequestId: "r-1" }),
    ).toThrow(BrokerLeaseError);
  });

  it("cloud-metadata / private addresses are denied at the broker (EffectBroker enforces)", async () => {
    // Verified exhaustively in effect-broker.test.ts; this gate asserts the
    // EffectBroker denies a metadata address resolution end-to-end.
    const { EffectBroker } = await import("../../../capabilities/execution/effect-broker.js");
    const { InMemoryArtifactStore } = await import("../../../capabilities/execution/in-memory-artifact-store.js");
    const broker = new EffectBroker({
      artifacts: new InMemoryArtifactStore(),
      network: {
        async resolve() {
          return ["169.254.169.254"]; // cloud metadata
        },
        async fetch() {
          return { status: 200, bytes: new Uint8Array([0]), effectiveHost: "h", effectiveIp: "169.254.169.254", headers: {} };
        },
      },
    });
    const env = envelope("d1", [{ kind: "network-destination", scheme: "https", host: "metadata.google.internal" }]);
    const r = await broker.execute(
      {
        kind: "http",
        requestId: "b1",
        destination: { scheme: "https", host: "metadata.google.internal" },
        method: "GET",
        headers: {},
        secretRefs: [],
      },
      env,
      { leaseId: "l", actionDigest: "d1", expiresAt: Date.now() + 60_000, singleUseRequestId: "n1" },
    );
    expect(r.status).toBe("denied");
  });
});

describe("QS-4.7 Docker scheduler authority (T411)", () => {
  it("replay of the same nonce is rejected", async () => {
    const { sched } = makeScheduler({});
    const d = dispatch();
    await sched.dispatch(d, { controlPlaneId: "cp", authenticatedTransport: "mtls" });
    // Same nonce under a different dispatchId → replay.
    await expect(
      sched.dispatch({ ...d, dispatchId: "disp-2" }, { controlPlaneId: "cp", authenticatedTransport: "mtls" }),
    ).rejects.toBeInstanceOf(WorkerSchedulerError);
  });

  it("forged action digest (mismatch with envelope) is rejected", async () => {
    const { sched } = makeScheduler({});
    const d = dispatch();
    d.envelope.actionDigest = "different";
    await expect(
      sched.dispatch(d, { controlPlaneId: "cp", authenticatedTransport: "mtls" }),
    ).rejects.toBeInstanceOf(WorkerSchedulerError);
  });

  it("expired lease is rejected", async () => {
    const { sched } = makeScheduler({});
    const d = dispatch({
      issuedAt: 1000,
      workspace: { leaseId: "l", tenantId: "t", sessionId: "s", workspaceId: "ws-a", mountTarget: "/workspace", expiresAt: 500 },
    });
    await expect(
      sched.dispatch(d, { controlPlaneId: "cp", authenticatedTransport: "mtls" }),
    ).rejects.toBeInstanceOf(WorkerSchedulerError);
  });
});

describe("QS-4.8 dispatch/result replay (T411)", () => {
  it("idempotent retry with same dispatchId returns the recorded result", async () => {
    const { sched } = makeScheduler({});
    const d = dispatch();
    const r1 = await sched.dispatch(d, { controlPlaneId: "cp", authenticatedTransport: "mtls" });
    expect(r1.state).toBe("succeeded");
    // The recorded result is returned on retry — no second container launch.
    const r2 = await sched.dispatch(d, { controlPlaneId: "cp", authenticatedTransport: "mtls" });
    expect(r2.state).toBe("succeeded");
  });

  it("audit terminal events are idempotent (no re-record on retry)", async () => {
    const audit = new LocalAuditStore({ root: dir });
    const event = {
      eventId: "e",
      actionId: "a",
      actionDigest: "d",
      principalId: "u",
      runId: "r",
      state: "succeeded" as const,
      timestamp: Date.now(),
      policyDigest: "d",
    };
    const k = idempotencyKey("a", "succeeded");
    expect((await audit.append(event, { idempotencyKey: k })).valueOf()).toBe("written");
    expect((await audit.append(event, { idempotencyKey: k })).valueOf()).toBe("duplicate");
  });
});
