/**
 * Worker scheduler, dispatch, lease, evidence, and result contracts —
 * Foundations (spec 008, server split).
 *
 * Versioned, transport-independent. Replay, cancellation, duplicate-result,
 * and unknown-version behavior are expressible without transport types.
 * Foundations imports no Seepient layer.
 */

import type { PreparedToolAction } from "./prepared-action.js";
import type { CapabilityEnvelope } from "./permission-policy.js";
import type { PreparedArtifactRef } from "./prepared-action.js";
import type {
  EnforcementEvidence,
  StructuredToolError,
} from "./execution-boundary.js";
import type { ToolResult } from "../types.js";

/** Current worker-protocol major version. Unknown majors are rejected. */
export const WORKER_PROTOCOL_VERSION = 1 as const;

export interface SchedulerAuthContext {
  controlPlaneId: string;
  authenticatedTransport: "mtls";
}

/** Workspace lease resolved by the scheduler's trusted tenant registry. */
export interface WorkspaceLease {
  leaseId: string;
  tenantId: string;
  sessionId: string;
  workspaceId: string;
  mountTarget: "/workspace";
  expiresAt: number;
}

/** Short-lived, action-bound broker capability token (not a credential). */
export interface WorkerBrokerLease {
  endpoint: string;
  token: string;
  actionDigest: string;
  expiresAt: number;
}

/**
 * Signed dispatch payload. Signature covers canonical serialization of every
 * field except `signature`. The scheduler signs only after validating mTLS
 * caller, image, workspace registry entry, action/envelope digest, limits,
 * and lease. A dispatch nonce is single-use and persisted by the scheduler
 * until lease expiry.
 */
export interface WorkerDispatch {
  version: 1;
  dispatchId: string;
  nonce: string;
  issuedAt: number;
  signingKeyId: string;
  action: PreparedToolAction;
  envelope: CapabilityEnvelope;
  workspace: WorkspaceLease;
  artifactManifest: PreparedArtifactRef[];
  brokerLease?: WorkerBrokerLease;
  deadline: number;
  signature: string;
}

export interface WorkerResult {
  version: 1;
  dispatchId: string;
  leaseId: string;
  actionDigest: string;
  state: "succeeded" | "failed" | "cancelled";
  result?: ToolResult;
  error?: StructuredToolError;
  evidence: EnforcementEvidence;
}

/**
 * The external Docker worker scheduler is the sole Docker-socket holder. It
 * launches one ephemeral, immutable-image container per run/session lease and
 * exchanges dispatch/result over an authenticated attach stream. Retry with
 * the same dispatch ID returns the recorded result or resumes the same lease;
 * it never launches a second effectful execution.
 */
export interface WorkerScheduler {
  dispatch(
    req: WorkerDispatch,
    auth: SchedulerAuthContext,
  ): Promise<WorkerResult>;
  cancel(leaseId: string, reason: string): Promise<void>;
}
