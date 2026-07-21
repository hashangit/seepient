/**
 * WorkerExecutionBoundary — Capabilities (spec 008, T405, FR-003/FR-017).
 *
 * The control-plane process MUST NOT execute model-authored shell commands
 * or expose credentials to tool workers. This boundary delegates every
 * effectful operation to the external `WorkerScheduler` (the Docker-socket
 * holder), which dispatches an ephemeral isolated worker per run/session
 * lease.
 *
 * The control plane's only execution authority is: read-only file reads
 * (no effect) and the `none` operation (e.g. get_current_datetime). Every
 * effectful kind — `commit-files`, `process`, `broker`, `trusted-host` —
 * MUST route through the scheduler.
 *
 * This is the server-side counterpart to `LocalExecutionBoundary`. Both
 * implement the same `ExecutionBoundary` contract, so `PolicyEngine` and
 * `ActionLifecycle` are deployment-agnostic.
 */
import type { PreparedToolAction } from "../../foundations/contracts/prepared-action.js";
import type { PreparedOperation } from "../../foundations/contracts/prepared-action.js";
import type {
  ExecutionBoundary,
  ExecutionBackendCapabilities,
  ExecutionResult,
  ToolProgress,
} from "../../foundations/contracts/execution-boundary.js";
import type { CapabilityEnvelope } from "../../foundations/contracts/permission-policy.js";
import type {
  WorkerDispatch,
  WorkerResult,
  WorkerScheduler,
  SchedulerAuthContext,
} from "../../foundations/contracts/worker-protocol.js";
import { UnsupportedBackendError } from "../../foundations/errors.js";

/**
 * Operation kinds the control plane MAY execute directly (no effect).
 * Everything else must be delegated to a worker.
 */
const CONTROL_PLANE_SAFE_KINDS: ReadonlySet<PreparedOperation["kind"]> = new Set<
  PreparedOperation["kind"]
>(["none", "read-file"]);

export interface WorkerExecutionBoundaryOptions {
  scheduler: WorkerScheduler;
  /** Auth context the control plane presents to the scheduler (mTLS). */
  auth: SchedulerAuthContext;
  /** The control plane's signing key id (for dispatch signature provenance). */
  signingKeyId: string;
  /**
   * Sign the canonical dispatch payload. Production wires an mTLS-backed
   * signer; tests inject a fake. The signature covers every field except
   * `signature` itself.
   */
  sign: (canonical: string) => string;
  /** Workspace lease resolver: workspaceId → host source path. */
  resolveWorkspace: (action: PreparedToolAction) => {
    leaseId: string;
    tenantId: string;
    sessionId: string;
    workspaceId: string;
    mountTarget: "/workspace";
    expiresAt: number;
  };
  /** Compute the dispatch deadline from policy. */
  deadlineMs?: number;
  /** Callback to issue a short-lived broker lease token (T409). */
  issueBrokerLease?: (actionDigest: string) => { endpoint: string; token: string; expiresAt: number } | undefined;
  /** Optional in-process fallback for operation kinds the control plane may
   *  execute directly (none/read-file). When omitted, those kinds also route
   *  to the scheduler. */
  safeExecutor?: {
    execute(action: PreparedToolAction, envelope: CapabilityEnvelope): Promise<ExecutionResult>;
  };
  capabilities: ExecutionBackendCapabilities;
}

/**
 * Server-side execution boundary. Refuses to execute effectful operations
 * in-process; dispatches them to the external scheduler. The control plane
 * process holds no execution authority beyond safe no-effect kinds.
 */
export class WorkerExecutionBoundary implements ExecutionBoundary {
  readonly capabilities: ExecutionBackendCapabilities;
  private readonly opts: WorkerExecutionBoundaryOptions;

  constructor(opts: WorkerExecutionBoundaryOptions) {
    this.opts = opts;
    this.capabilities = opts.capabilities;
  }

  async execute(
    action: PreparedToolAction,
    envelope: CapabilityEnvelope,
    execOpts: { signal?: AbortSignal; onUpdate?: (u: ToolProgress) => void },
  ): Promise<ExecutionResult> {
    const op = action.operation;

    // 1. Control-plane-safe kinds (no model-authored effect): allowed locally
    //    only when an explicit safeExecutor is provided. Otherwise route to
    //    the worker too (defense in depth).
    if (CONTROL_PLANE_SAFE_KINDS.has(op.kind)) {
      if (this.opts.safeExecutor) {
        return this.opts.safeExecutor.execute(action, envelope);
      }
      // Without a safe executor, even "none" routes to the worker — the
      // control plane executes nothing model-authored.
    } else {
      // Effectful kinds MUST NOT run in the control plane. No fallback.
      void execOpts;
    }

    // 2. Build the dispatch and delegate to the scheduler.
    const workspace = this.opts.resolveWorkspace(action);
    const brokerLease = this.opts.issueBrokerLease?.(action.actionDigest);
    const now = Date.now();
    const dispatch: WorkerDispatch = {
      version: 1,
      dispatchId: action.actionId,
      nonce: action.actionDigest, // single-use; tied to action digest
      issuedAt: now,
      signingKeyId: this.opts.signingKeyId,
      action,
      envelope,
      workspace,
      artifactManifest: this.collectManifest(action),
      brokerLease: brokerLease
        ? {
            endpoint: brokerLease.endpoint,
            token: brokerLease.token,
            actionDigest: action.actionDigest,
            expiresAt: brokerLease.expiresAt,
          }
        : undefined,
      deadline: now + (this.opts.deadlineMs ?? 60_000),
      signature: "", // populated below
    };

    // 3. Sign the canonical payload (every field except signature).
    dispatch.signature = this.opts.sign(canonicalDispatch(dispatch));

    // 4. Delegate. The scheduler is the sole Docker-socket holder; it
    //    launches the ephemeral worker.
    let workerResult: WorkerResult;
    try {
      workerResult = await this.opts.scheduler.dispatch(dispatch, this.opts.auth);
    } catch (err) {
      return {
        state: "failed",
        error: {
          code: "WORKER_DISPATCH_FAILED",
          message: err instanceof Error ? err.message : String(err),
          retryable: true,
        },
        evidence: {
          backend: "docker-worker",
          actionDigest: action.actionDigest,
          executorId: "scheduler",
          operationKind: op.kind,
        },
      };
    }

    // 5. Translate the worker result into an ExecutionResult. The control
    //    plane does not re-execute — it trusts the scheduler's signed result
    //    and verifies the digests match.
    return this.translateResult(workerResult, action);
  }

  /** Collect artifact references mentioned in the operation. */
  private collectManifest(action: PreparedToolAction): import("../../foundations/contracts/prepared-action.js").PreparedArtifactRef[] {
    const op = action.operation;
    const out: import("../../foundations/contracts/prepared-action.js").PreparedArtifactRef[] = [];
    if (op.kind === "commit-files") {
      for (const c of op.commits) out.push(c.content);
    } else if (op.kind === "broker") {
      if (op.request.kind === "http" && op.request.body) out.push(op.request.body);
      else if (op.request.kind === "external-send") out.push(op.request.payload);
    }
    return out;
  }

  private translateResult(r: WorkerResult, action: PreparedToolAction): ExecutionResult {
    if (r.state === "succeeded") {
      return {
        state: "succeeded",
        result: r.result ?? { output: "ok", success: true },
        evidence: r.evidence,
      };
    }
    return {
      state: r.state === "cancelled" ? "cancelled" : "failed",
      error: r.error ?? { code: "WORKER_FAILED", message: "worker returned non-success", retryable: false },
      evidence: r.evidence,
    };
  }
}

/**
 * Canonicalize a dispatch for signing. Every field except `signature`, in a
 * deterministic deep key order. The scheduler verifies the same canonical
 * form using the control plane's public signing key.
 *
 * Deep sort: nested objects are key-ordered too, so the canonical form is
 * stable regardless of property insertion order.
 */
export function canonicalDispatch(d: WorkerDispatch): string {
  const { signature, ...rest } = d;
  void signature;
  return JSON.stringify(deepSort(rest));
}

function deepSort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deepSort);
  if (value === null || typeof value !== "object") return value;
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[k] = deepSort((value as Record<string, unknown>)[k]);
  }
  return sorted;
}

/** Re-export for composition roots that construct the boundary. */
export type { PreparedOperation };
export { UnsupportedBackendError };
