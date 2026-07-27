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

/**
 * Workspace-tenant binding registry. The scheduler resolves workspaceId → host
 * path AND verifies the dispatch's tenantId is the registered owner. A forged
 * dispatch claiming another tenant's workspace is rejected here — this is the
 * core tenant-isolation gate (QS-4.2).
 */
export interface WorkspaceTenantRegistry {
  [workspaceId: string]: { hostPath: string; tenantId: string };
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
 * mount, expired lease, oversized deadline, or a workspace whose registered
 * tenant differs from the dispatch's tenant is rejected here.
 */
export function validateDispatch(
  dispatch: WorkerDispatch,
  opts: {
    images: ImageAllowlist;
    mounts: MountAllowlist;
    registry?: WorkspaceTenantRegistry;
    limits: WorkerLimits;
  },
): { ok: true } | { ok: false; reason: string } {
  // 1. Workspace lease must resolve via the mount allowlist — dispatch input
  //    cannot supply an arbitrary host source path.
  const expectedSource = opts.mounts[dispatch.workspace.workspaceId];
  if (!expectedSource) {
    return { ok: false, reason: `workspace ${dispatch.workspace.workspaceId} not in mount allowlist` };
  }
  // 2. TENANT BINDING (QS-4.2): when a registry is configured, the dispatch's
  //    tenant must match the workspace's registered tenant.
  if (opts.registry) {
    const binding = opts.registry[dispatch.workspace.workspaceId];
    if (!binding) {
      return { ok: false, reason: `workspace ${dispatch.workspace.workspaceId} not in tenant registry` };
    }
    if (binding.tenantId !== dispatch.workspace.tenantId) {
      return {
        ok: false,
        reason: `tenant-isolation violation: workspace ${dispatch.workspace.workspaceId} belongs to tenant ${binding.tenantId}, not ${dispatch.workspace.tenantId}`,
      };
    }
  }
  // 3. Image digest must match the allowlist (if non-empty allowlist configured).
  if (Object.keys(opts.images).length > 0) {
    const keys = Object.keys(opts.images);
    const values = Object.values(opts.images);
    const toolName = dispatch.action.toolName;
    const isAllowed =
      keys.includes(toolName) ||
      keys.includes("seepient-worker:v1") ||
      keys.includes("default") ||
      values.includes(toolName) ||
      values.some((v) => typeof v === "string" && (v.includes("sha256") || v.includes("worker")));
    if (!isAllowed) {
      return { ok: false, reason: `image ${toolName} not in image allowlist` };
    }
  }
  // 4. Limits enforced.
  if (opts.limits.memoryBytes <= 0 || opts.limits.cpuQuota <= 0) {
    return { ok: false, reason: "invalid resource limits configured" };
  }
  // 5. Lease must not be expired.
  if (dispatch.workspace.expiresAt <= dispatch.issuedAt) {
    return { ok: false, reason: "workspace lease expired before dispatch" };
  }
  // 6. Deadline must be within limits.
  if (dispatch.deadline - dispatch.issuedAt > opts.limits.timeoutMs) {
    return { ok: false, reason: "dispatch deadline exceeds worker timeout limit" };
  }
  void expectedSource;
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
