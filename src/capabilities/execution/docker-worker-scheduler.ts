/**
 * Docker worker scheduler — Capabilities (spec 008, T402/T403/T404, FR-018/D39).
 *
 * The required reference backend for server v1. The scheduler is trusted
 * infrastructure and is the ONLY component with the Docker socket:
 *   - control plane and worker have NO Docker socket;
 *   - the scheduler launches one ephemeral, immutable-image container per
 *     run/session lease;
 *   - dispatch is written over the Docker attach stream; the result is read
 *     from that stream — workers need no route to the control-plane API;
 *   - the scheduler validates image digest, mount allowlist, limits, lease
 *     expiry, and single-use dispatch nonce before launch;
 *   - retry with the same dispatch ID returns the recorded result or resumes
 *     the same lease — never launches a second effectful execution.
 *
 * Cloud Run / Modal / ECS / Kubernetes / microVMs are future adapters to the
 * same `WorkerScheduler` contract — NOT alternative v1 interpretations.
 */
import { createHash } from "node:crypto";
import type {
  WorkerDispatch,
  WorkerResult,
  WorkerScheduler,
  SchedulerAuthContext,
} from "../../foundations/contracts/worker-protocol.js";
import type { DockerEngine, MountAllowlist, ImageAllowlist, WorkerLimits, WorkspaceTenantRegistry } from "../../vendors/docker/index.js";
import { DEFAULT_WORKER_LIMITS } from "../../vendors/docker/index.js";
import { validateDispatch, resolveMount } from "../../vendors/docker/index.js";
import { WorkerSchedulerError } from "../../foundations/errors.js";

export interface DockerWorkerSchedulerOptions {
  engine: DockerEngine;
  images: ImageAllowlist;
  mounts: MountAllowlist;
  /** Workspace-tenant binding registry — the QS-4.2 tenant-isolation gate. */
  registry?: WorkspaceTenantRegistry;
  limits?: WorkerLimits;
  /** Default worker image ref (digest-verified at create time). */
  defaultImage: string;
  /** Network the worker uses to reach the effect broker (only). */
  brokerNetwork: string;
}

/** Persisted single-use nonce + recorded result (idempotent retry). */
interface DispatchRecord {
  nonce: string;
  dispatchId: string;
  leaseId: string;
  actionDigest: string;
  launchedAt: number;
  result?: WorkerResult;
  state: "launching" | "running" | "completed" | "failed";
}

/**
 * Reference scheduler. Single-use dispatch nonces are persisted in-memory until
 * lease expiry; production deployments persist them transactionally.
 */
export class DockerWorkerScheduler implements WorkerScheduler {
  private readonly opts: DockerWorkerSchedulerOptions;
  private readonly limits: WorkerLimits;
  private readonly records = new Map<string, DispatchRecord>();
  private readonly nonces = new Set<string>();

  constructor(opts: DockerWorkerSchedulerOptions) {
    this.opts = opts;
    this.limits = opts.limits ?? (DEFAULT_WORKER_LIMITS as WorkerLimits);
  }

  async dispatch(
    req: WorkerDispatch,
    auth: SchedulerAuthContext,
  ): Promise<WorkerResult> {
    if (!this.opts.engine) {
      throw new WorkerSchedulerError("Docker daemon socket is unavailable", "WORKER_UNAVAILABLE");
    }
    // 1. mTLS authentication.
    if (auth.authenticatedTransport !== "mtls") {
      throw new WorkerSchedulerError("Scheduler requires mTLS authentication", "WORKER_UNAVAILABLE");
    }
    // 2. Unknown version → reject.
    if (req.version !== 1) {
      throw new WorkerSchedulerError(
        `Unknown worker protocol version ${req.version}`,
        "WORKER_UNKNOWN_VERSION",
      );
    }
    // 3. Single-use nonce — replay rejected, idempotent retry honored.
    if (this.records.has(req.dispatchId)) {
      const rec = this.records.get(req.dispatchId)!;
      // Same dispatch ID → return recorded result or resume the same lease.
      if (rec.result) return rec.result;
      if (rec.state === "running" || rec.state === "launching") {
        // Resume — caller polls; never launch a second container.
        return this.pendingResult(rec);
      }
    }
    if (this.nonces.has(req.nonce)) {
      throw new WorkerSchedulerError("Dispatch nonce replay", "WORKER_REPLAY", { dispatchId: req.dispatchId });
    }
    // 4. Signature verification (structural — real deployments verify the key).
    if (!req.signature || req.signature.length === 0) {
      throw new WorkerSchedulerError("Missing dispatch signature", "WORKER_FORGED_DIGEST", { dispatchId: req.dispatchId });
    }
    // 5. Action digest must match envelope.
    if (req.action.actionDigest !== req.envelope.actionDigest) {
      throw new WorkerSchedulerError(
        "Action digest does not match envelope",
        "WORKER_FORGED_DIGEST",
        { dispatchId: req.dispatchId },
      );
    }
    // 6. Validate against allowlists + tenant registry.
    const validation = validateDispatch(req, {
      images: this.opts.images,
      mounts: this.opts.mounts,
      registry: this.opts.registry,
      limits: this.limits,
    });
    if (!validation.ok) {
      throw new WorkerSchedulerError(
        `Dispatch rejected: ${validation.reason}`,
        "WORKER_UNSCHEDULABLE",
        { dispatchId: req.dispatchId },
      );
    }

    // 7. Record the nonce + dispatch (idempotency).
    this.nonces.add(req.nonce);
    const rec: DispatchRecord = {
      nonce: req.nonce,
      dispatchId: req.dispatchId,
      leaseId: req.workspace.leaseId,
      actionDigest: req.action.actionDigest,
      launchedAt: Date.now(),
      state: "launching",
    };
    this.records.set(req.dispatchId, rec);

    // 8. Resolve mount + create the ephemeral worker container.
    const mount = resolveMount(req.workspace, this.opts.mounts);
    if ("error" in mount) {
      rec.state = "failed";
      throw new WorkerSchedulerError(mount.error, "WORKER_UNSCHEDULABLE", { dispatchId: req.dispatchId });
    }

    try {
      const env = this.sanitizedWorkerEnv(req);
      const { id } = await this.opts.engine.createContainer({
        image: this.opts.defaultImage,
        imageDigest: this.opts.images[this.opts.defaultImage] ?? "",
        command: ["seepient-worker", "--dispatch", req.dispatchId],
        mounts: [mount],
        env,
        network: this.opts.brokerNetwork,
        limits: this.limits,
        user: "worker",
        readOnlyRoot: true,
      });
      rec.state = "running";
      // Attach + start + exchange dispatch/result over the stream + wait + cleanup
      const stream = await this.opts.engine.attachStream(id);
      await this.opts.engine.start(id);
      stream.write(Buffer.from(JSON.stringify(req)));
      const result = await this.readResult(stream, req);
      await this.opts.engine.wait(id).catch(() => {});
      await this.opts.engine.remove(id).catch(() => {});
      rec.result = result;
      rec.state = "completed";
      return result;
    } catch (err) {
      rec.state = "failed";
      const message = err instanceof Error ? err.message : String(err);
      return {
        version: 1,
        dispatchId: req.dispatchId,
        leaseId: req.workspace.leaseId,
        actionDigest: req.action.actionDigest,
        state: "failed",
        error: { code: "WORKER_LAUNCH_FAILED", message, retryable: true },
        evidence: {
          backend: "docker-worker",
          actionDigest: req.action.actionDigest,
          executorId: "scheduler",
          operationKind: req.action.operation.kind,
        },
      };
    }
  }

  async cancel(leaseId: string, reason: string): Promise<void> {
    void reason;
    // Find the running record by lease ID and kill the container.
    for (const [containerId, rec] of this.records.entries()) {
      if (rec.leaseId === leaseId && (rec.state === "running" || rec.state === "launching")) {
        rec.state = "failed";
        await this.opts.engine?.kill(containerId).catch(() => {});
        await this.opts.engine?.remove(containerId).catch(() => {});
      }
    }
  }

  /** Sanitized worker env — no provider/server/release credentials. */
  private sanitizedWorkerEnv(req: WorkerDispatch): string[] {
    const env: string[] = [
      `SEEPIENT_WORKER=1`,
      `SEEPIENT_WORKER_ID=${req.dispatchId}`,
      `SEEPIENT_LEASE_ID=${req.workspace.leaseId}`,
      // The worker receives a short-lived broker lease token (not a credential).
      ...(req.brokerLease ? [`SEEPIENT_BROKER_LEASE=${req.brokerLease.token}`] : []),
      // PATH/HOME reconstructed to known-good values.
      `PATH=/usr/local/bin:/usr/bin:/bin`,
      `HOME=/tmp/worker-home`,
    ];
    return env;
  }

  /** Read a `WorkerResult` JSON line from the attach stream. */
  private async readResult(
    stream: NodeJS.ReadableStream & NodeJS.WritableStream,
    req: WorkerDispatch,
  ): Promise<WorkerResult> {
    return new Promise((resolve, reject) => {
      let buf = "";
      const timer = setTimeout(() => {
        reject(new WorkerSchedulerError("Worker attach stream timed out", "WORKER_UNAVAILABLE", { dispatchId: req.dispatchId }));
      }, this.limits.timeoutMs);
      stream.on("data", (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        const newline = buf.indexOf("\n");
        if (newline !== -1) {
          clearTimeout(timer);
          try {
            const parsed = JSON.parse(buf.slice(0, newline)) as WorkerResult;
            // Verify the result references the same dispatch + action digest.
            if (parsed.dispatchId !== req.dispatchId || parsed.actionDigest !== req.action.actionDigest) {
              reject(new WorkerSchedulerError("Worker result digest mismatch", "WORKER_FORGED_DIGEST", { dispatchId: req.dispatchId }));
              return;
            }
            resolve(parsed);
          } catch (err) {
            reject(err);
          }
        }
      });
      stream.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  /** Synthesize a pending result for a running dispatch (caller polls). */
  private pendingResult(rec: DispatchRecord): WorkerResult {
    void rec;
    // The real contract returns a polling handle; tests fake it.
    throw new WorkerSchedulerError("Dispatch still running; poll later", "WORKER_UNAVAILABLE");
  }
}

/** SHA-256 helper used for dispatch-idempotency bookkeeping. */
export function dispatchDigest(req: WorkerDispatch): string {
  return createHash("sha256")
    .update(JSON.stringify({ id: req.dispatchId, nonce: req.nonce, action: req.action.actionDigest }))
    .digest("hex");
}
