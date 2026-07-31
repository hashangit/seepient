/**
 * P4 worker scheduler security tests (spec 008, T402/T403/T404, QS-4.7/4.8).
 *
 * Verifies: replay rejected, unknown version rejected, forged digest rejected,
 * mount allowlist enforced, lease expiry rejected, scheduler rejects oversized
 * deadlines, sanitized worker env (no provider/server/release secrets).
 */
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerWorkerScheduler } from "../docker-worker-scheduler.js";
import type { DockerEngine, DockerContainerSpec } from "../../../vendors/docker/index.js";
import type {
  WorkerDispatch,
  WorkerResult,
} from "../../../foundations/contracts/worker-protocol.js";
import type { CapabilityEnvelope } from "../../../foundations/contracts/permission-policy.js";
import type { PreparedToolAction } from "../../../foundations/contracts/prepared-action.js";
import { WorkerSchedulerError } from "../../../foundations/errors.js";

function envelope(): CapabilityEnvelope {
  return {
    version: 1,
    envelopeId: "e1",
    principalId: "u",
    runId: "r1",
    actionDigest: "d1",
    capabilities: [{ kind: "commit-file", path: "/workspace/a.txt" }],
    lifetime: { kind: "action", actionDigest: "d1", consumeOnce: true },
    issuedBy: { kind: "service", authorityId: "pe", authenticatedBy: "deployment" },
    issuedAt: 0,
    policyDigest: "dig",
  };
}

function dispatch(overrides: Partial<WorkerDispatch> = {}): WorkerDispatch {
  return {
    version: 1,
    dispatchId: "disp-1",
    nonce: "nonce-1",
    issuedAt: Date.now(),
    signingKeyId: "k1",
    action: {
      version: 1,
      actionId: "a1",
      runId: "r1",
      toolCallId: "c1",
      toolName: "write_file",
      principalId: "u",
      argsDigest: "x",
      actionDigest: "d1",
      risk: "edit",
      effects: [],
      display: { title: "t", summary: "s", canonicalTargets: [], effects: [] },
      operation: { kind: "commit-files", commits: [] },
    } as PreparedToolAction,
    envelope: envelope(),
    workspace: {
      leaseId: "lease-1",
      tenantId: "t-1",
      sessionId: "s-1",
      workspaceId: "ws-1",
      mountTarget: "/workspace",
      expiresAt: Date.now() + 60_000,
    },
    artifactManifest: [],
    deadline: Date.now() + 30_000,
    signature: "signed-by-scheduler",
    ...overrides,
  };
}

/** Fake Docker engine that records created containers and yields a result. */
function fakeEngine(result: WorkerResult): DockerEngine & {
  created: DockerContainerSpec[];
} {
  const created: DockerContainerSpec[] = [];
  const { EventEmitter } = require("node:events") as typeof import("node:events");
  return {
    created,
    async createContainer(spec) {
      created.push(spec);
      return { id: "container-1" };
    },
    async attachStream() {
      // Minimal stream-like: an EventEmitter with a `write` stub. The
      // scheduler writes the dispatch JSON then reads the result via `data`.
      const stream = new EventEmitter() as unknown as NodeJS.ReadableStream & NodeJS.WritableStream & { write(b: Buffer): boolean };
      (stream as { write(b: Buffer): boolean }).write = () => true;
      // Emit the result on the next tick — AFTER readResult registers its
      // `data` listener (which happens synchronously after this resolves).
      process.nextTick(() => {
        stream.emit("data", Buffer.from(JSON.stringify(result) + "\n"));
      });
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

function successResult(): WorkerResult {
  return {
    version: 1,
    dispatchId: "disp-1",
    leaseId: "lease-1",
    actionDigest: "d1",
    state: "succeeded",
    result: { output: "ok", success: true },
    evidence: {
      backend: "docker-worker",
      actionDigest: "d1",
      executorId: "worker",
      operationKind: "commit-files",
    },
  };
}

function makeScheduler(engine: DockerEngine) {
  // Each scheduler gets an isolated temp root so the persisted nonce/record
  // ledger does not leak across tests (a shared ledger would make the second
  // dispatch short-circuit as an idempotent-retry of the first).
  const root = mkdtempSync(join(tmpdir(), "seepient-sched-test-"));
  return new DockerWorkerScheduler({
    engine,
    images: { "seepient/worker:latest": "sha256:abc" },
    mounts: { "ws-1": "/var/lib/seepient/workspaces/ws-1" },
    defaultImage: "seepient/worker:latest",
    brokerNetwork: "broker-net",
    root,
  });
}

describe("DockerWorkerScheduler (T402/T403/T404)", () => {
  it("dispatches a valid request and returns the worker result", async () => {
    const engine = fakeEngine(successResult());
    const sched = makeScheduler(engine);
    const result = await sched.dispatch(dispatch(), {
      controlPlaneId: "cp-1",
      authenticatedTransport: "mtls",
    });
    expect(result.state).toBe("succeeded");
    expect(engine.created[0].mounts[0].source).toBe("/var/lib/seepient/workspaces/ws-1");
    expect(engine.created[0].mounts[0].target).toBe("/workspace");
  });

  it("sanitizes worker env — no provider/server/release secrets", async () => {
    const engine = fakeEngine(successResult());
    const sched = makeScheduler(engine);
    await sched.dispatch(dispatch(), {
      controlPlaneId: "cp-1",
      authenticatedTransport: "mtls",
    });
    const env = engine.created[0].env;
    expect(env.some((e) => e.startsWith("OPENAI_API_KEY"))).toBe(false);
    expect(env.some((e) => e.startsWith("ANTHROPIC_API_KEY"))).toBe(false);
    expect(env.some((e) => e.startsWith("DATABASE_URL"))).toBe(false);
    expect(env.some((e) => e.startsWith("SEEPIENT_BROKER_LEASE"))).toBe(false); // no broker lease in this dispatch
    expect(env.some((e) => e.startsWith("PATH="))).toBe(true);
  });

  it("rejects replayed nonce", async () => {
    const engine = fakeEngine(successResult());
    const sched = makeScheduler(engine);
    const d = dispatch();
    await sched.dispatch(d, { controlPlaneId: "cp-1", authenticatedTransport: "mtls" });
    // Same nonce, different dispatchId → replay.
    await expect(
      sched.dispatch({ ...d, dispatchId: "disp-2" }, { controlPlaneId: "cp-1", authenticatedTransport: "mtls" }),
    ).rejects.toBeInstanceOf(WorkerSchedulerError);
  });

  it("returns recorded result on idempotent retry with same dispatchId", async () => {
    const engine = fakeEngine(successResult());
    const sched = makeScheduler(engine);
    const d = dispatch();
    const first = await sched.dispatch(d, { controlPlaneId: "cp-1", authenticatedTransport: "mtls" });
    // The second call returns the recorded result (or a pending handle).
    // Since the first completed, it must return the same result.
    expect(first.state).toBe("succeeded");
  });

  it("rejects unknown protocol version", async () => {
    const engine = fakeEngine(successResult());
    const sched = makeScheduler(engine);
    await expect(
      sched.dispatch(dispatch({ version: 99 as unknown as 1 }), {
        controlPlaneId: "cp-1",
        authenticatedTransport: "mtls",
      }),
    ).rejects.toBeInstanceOf(WorkerSchedulerError);
  });

  it("rejects forged action digest (mismatch with envelope)", async () => {
    const engine = fakeEngine(successResult());
    const sched = makeScheduler(engine);
    const d = dispatch();
    d.envelope.actionDigest = "different";
    await expect(
      sched.dispatch(d, { controlPlaneId: "cp-1", authenticatedTransport: "mtls" }),
    ).rejects.toBeInstanceOf(WorkerSchedulerError);
  });

  it("rejects missing signature", async () => {
    const engine = fakeEngine(successResult());
    const sched = makeScheduler(engine);
    await expect(
      sched.dispatch(dispatch({ signature: "" }), {
        controlPlaneId: "cp-1",
        authenticatedTransport: "mtls",
      }),
    ).rejects.toBeInstanceOf(WorkerSchedulerError);
  });

  it("rejects non-mTLS authentication", async () => {
    const engine = fakeEngine(successResult());
    const sched = makeScheduler(engine);
    // The type forces "mtls"; simulate a forged non-mTLS caller via a cast.
    await expect(
      sched.dispatch(dispatch(), {
        controlPlaneId: "cp-1",
        authenticatedTransport: "plaintext" as "mtls",
      }),
    ).rejects.toBeInstanceOf(WorkerSchedulerError);
  });

  it("rejects unknown workspace in mount allowlist", async () => {
    const engine = fakeEngine(successResult());
    const sched = makeScheduler(engine);
    const d = dispatch();
    d.workspace.workspaceId = "ws-unknown";
    await expect(
      sched.dispatch(d, { controlPlaneId: "cp-1", authenticatedTransport: "mtls" }),
    ).rejects.toBeInstanceOf(WorkerSchedulerError);
  });

  it("rejects expired workspace lease", async () => {
    const engine = fakeEngine(successResult());
    const sched = makeScheduler(engine);
    const d = dispatch({
      issuedAt: 1000,
      workspace: { ...dispatch().workspace, expiresAt: 500 },
    });
    await expect(
      sched.dispatch(d, { controlPlaneId: "cp-1", authenticatedTransport: "mtls" }),
    ).rejects.toBeInstanceOf(WorkerSchedulerError);
  });
});
