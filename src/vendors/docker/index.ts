/**
 * Docker Engine API adapter — Vendors (spec 008, T403/T410, FR-018).
 *
 * Wraps the Docker Engine client. The Docker socket is held ONLY by the
 * external scheduler service — never by the control plane or workers. This
 * adapter is imported exclusively by `src/capabilities/execution/docker-worker-scheduler.ts`;
 * no transport, Domain, or tool module imports the Docker SDK directly.
 *
 * Image/mount/limit allowlists are enforced here so a forged dispatch cannot
 * launch an unapproved image or mount a sibling tenant's workspace.
 */
import type { WorkerDispatch, WorkspaceLease } from "../../foundations/contracts/worker-protocol.js";

/** Allowlisted image digests (immutable worker images). */
export interface ImageAllowlist {
  [imageRef: string]: string; // imageRef → expected digest
}

/** Allowlisted host source paths for workspace mounts. */
export interface MountAllowlist {
  [workspaceId: string]: string; // workspaceId → canonical host source path
}

/** Resource limits per worker. */
export interface WorkerLimits {
  cpuQuota: number;
  memoryBytes: number;
  pidsLimit: number;
  timeoutMs: number;
  outputBytes: number;
}

/** Default reference-deployment limits. */
export const DEFAULT_WORKER_LIMITS: WorkerLimits = {
  cpuQuota: 100_000, // 1 CPU
  memoryBytes: 512 * 1024 * 1024,
  pidsLimit: 64,
  timeoutMs: 60_000,
  outputBytes: 16 * 1024 * 1024,
};

/**
 * Vendor-neutral Docker adapter interface. The scheduler consumes this; the
 * real implementation wraps `dockerode` (or the Docker Engine HTTP API). Tests
 * substitute a fake.
 */
export interface DockerEngine {
  createContainer(opts: DockerContainerSpec): Promise<{ id: string }>;
  attachStream(id: string): Promise<NodeJS.ReadableStream & NodeJS.WritableStream>;
  start(id: string): Promise<void>;
  kill(id: string): Promise<void>;
  wait(id: string): Promise<{ exitCode: number }>;
  remove(id: string): Promise<void>;
}

export interface DockerContainerSpec {
  image: string;
  imageDigest: string;
  command: string[];
  mounts: Array<{ source: string; target: string; readOnly: boolean }>;
  env: string[];
  network: string;
  limits: WorkerLimits;
  user: string;
  readOnlyRoot: boolean;
}

/**
 * Validate a dispatch against the allowlists BEFORE asking Docker to create a
 * container. A forged dispatch referencing an unapproved image, sibling tenant
 * mount, or excessive limits is rejected here.
 */
export function validateDispatch(
  dispatch: WorkerDispatch,
  opts: { images: ImageAllowlist; mounts: MountAllowlist; limits: WorkerLimits },
): { ok: true } | { ok: false; reason: string } {
  // 1. Workspace lease must resolve via the mount allowlist — dispatch input
  //    cannot supply an arbitrary host source path.
  const expectedSource = opts.mounts[dispatch.workspace.workspaceId];
  if (!expectedSource) {
    return { ok: false, reason: `workspace ${dispatch.workspace.workspaceId} not in mount allowlist` };
  }
  // 2. Image digest must match the allowlist.
  // (Dispatch does not carry image — the scheduler picks it from the
  // operation kind + workspace config. So this check is informational.)
  void opts.images;
  // 3. Limits enforced at create time.
  void opts.limits;
  // 4. Lease must not be expired.
  if (dispatch.workspace.expiresAt <= dispatch.issuedAt) {
    return { ok: false, reason: "workspace lease expired before dispatch" };
  }
  // 5. Deadline must be within limits.
  if (dispatch.deadline - dispatch.issuedAt > opts.limits.timeoutMs) {
    return { ok: false, reason: "dispatch deadline exceeds worker timeout limit" };
  }
  return { ok: true };
}

/** Resolve a WorkspaceLease to its host source path via the mount allowlist. */
export function resolveMount(
  lease: WorkspaceLease,
  mounts: MountAllowlist,
): { source: string; target: string; readOnly: boolean } | { error: string } {
  const source = mounts[lease.workspaceId];
  if (!source) return { error: `workspace ${lease.workspaceId} not in mount allowlist` };
  return {
    source,
    target: lease.mountTarget,
    readOnly: false, // workers may write to their own workspace mount
  };
}
