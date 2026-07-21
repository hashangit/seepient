/**
 * Execution broker, artifact, commit, egress, secret, model-egress, policy-
 * store, and audit-store contracts — Foundations (spec 008).
 *
 * These are the trusted-service contracts behind `ExecutionBoundary`. Local
 * surfaces inject in-process implementations; server workers use authenticated
 * narrow service endpoints. Both forms enforce identical Foundations contracts.
 * No contract here exposes raw secret retrieval or a generic socket API.
 *
 * Foundations imports no Seepient layer.
 */

import type { CapabilityEnvelope, DecisionAuthority } from "./permission-policy.js";
import type {
  CanonicalPathTarget,
  FileSnapshot,
  NetworkDestination,
  ExternalRecipient,
  JsonValue,
} from "./tool-effects.js";
import type { PreparedArtifactRef, BrokeredEffectRequest } from "./prepared-action.js";
import type { PermissionDenyReason } from "./permission-policy.js";
import type { CapabilitySet } from "./permission-policy.js";
import type { StructuredToolError } from "./execution-boundary.js";

// ── Preparation artifact store ──────────────────────────────────────────

/**
 * Private, content-addressed artifact storage. Artifacts are named by random
 * ID, verified by SHA-256 + length on every boundary crossing, never
 * addressed by a caller-supplied host path, and removed after the terminal
 * action/run retention deadline.
 */
export interface PreparationArtifactStore {
  put(bytes: Uint8Array, mediaType: string): Promise<PreparedArtifactRef>;
  read(ref: PreparedArtifactRef): Promise<Uint8Array>;
  stat(ref: PreparedArtifactRef): Promise<{
    exists: boolean;
    sha256: string;
    byteLength: number;
  }>;
  deleteRun(runId: string): Promise<void>;
}

// ── Exact file commit broker ────────────────────────────────────────────

export interface FileCommitRequest {
  requestId: string;
  actionDigest: string;
  destination: CanonicalPathTarget;
  content: PreparedArtifactRef;
  expected?: FileSnapshot;
}

/** `FileWriteMetadata` from existing presentation contract (re-used). */
export interface FileWriteMetadata {
  path: string;
  isNewFile: boolean;
  byteDelta: number;
  [key: string]: unknown;
}

/**
 * Validates an action-scoped `commit-file` capability, verifies the artifact
 * digest, and delegates the complete operation to the packaged
 * `seepient-fs-commit` helper. Absent helper or primitive ⇒ `exactCommit:false`
 * and the operation fails closed.
 */
export interface FileCommitBroker {
  commit(
    req: {
      envelope: CapabilityEnvelope;
      destination: string;
      content: Uint8Array;
      expected?: FileSnapshot;
    },
  ): Promise<FileWriteMetadata>;
}

// ── Typed effect, egress, and secret broker ─────────────────────────────

export interface BrokerAuthContext {
  workerId?: string;
  leaseId: string;
  actionDigest: string;
  expiresAt: number;
  singleUseRequestId: string;
}

export interface OpaqueSecretLease {
  leaseId: string;
  expiresAt: number;
}

/**
 * Internal, action-bound secret lease. Usable only inside the broker process;
 * never reveals raw values to workers or callers.
 */
export interface SecretResolver {
  createBrokerLease(
    refs: string[],
    envelope: CapabilityEnvelope,
  ): Promise<OpaqueSecretLease>;
}

export interface BrokeredEffectResult {
  requestId: string;
  status: "succeeded" | "failed" | "denied";
  output?: PreparedArtifactRef;
  effectiveDestination?: NetworkDestination;
  error?: StructuredToolError;
}

/**
 * The broker owns DNS, connections, redirects, and internal secret
 * resolution. It rejects non-HTTP(S) schemes, loopback/private/link-local/
 * reserved/metadata addresses, unauthorized ports, redirects outside the
 * capability, and DNS rebinding between validation and connect. Direct worker
 * egress is disabled when filtered egress is claimed. Raw secret retrieval is
 * not a broker operation.
 */
export interface EffectBroker {
  execute(
    request: BrokeredEffectRequest,
    envelope: CapabilityEnvelope,
    auth: BrokerAuthContext,
  ): Promise<BrokeredEffectResult>;
}

// ── Model egress gate ───────────────────────────────────────────────────

export type ModelEgressDecision =
  | { decision: "allow" }
  | { decision: "deny"; reason: PermissionDenyReason; message: string };

/**
 * Invoked before tool output enters model-visible history or is sent to a
 * provider. Secret-class data, active policy, approval credentials, release
 * keys, and control-plane credentials are immutable denies. Local/on-device
 * providers still pass through the gate with an explicit provider class.
 */
export interface ModelEgressGate {
  authorize(
    req: {
      actionDigest: string;
      providerClass: string;
      dataClasses: string[];
      sourceArtifact?: PreparedArtifactRef;
    },
    envelope: CapabilityEnvelope,
  ): Promise<ModelEgressDecision>;
}

// ── Protected policy store ──────────────────────────────────────────────

export interface PolicySnapshot {
  workspaceId: string;
  version: number;
  policyDigest: string;
  policy: CapabilitySet;
}

/**
 * The only active-policy mutation API. Stale `expectedVersion` returns
 * `policy-conflict`; it never overwrites. Local storage is
 * `~/.seepient/security/policies/<workspace-id>.json` with private
 * permissions, exclusive lock, fsync, atomic rename, version increment, and
 * post-write digest verification. Server storage uses a transaction + row
 * version.
 */
export interface PolicyStore {
  read(workspaceId: string): Promise<PolicySnapshot>;
  compareAndSet(
    workspaceId: string,
    expectedVersion: number,
    next: CapabilitySet,
    actor: DecisionAuthority,
  ): Promise<PolicySnapshot>;
}

// ── Audit store ─────────────────────────────────────────────────────────

export type ActionState =
  | "prepared"
  | "denied"
  | "awaiting-approval"
  | "approved"
  | "approval-denied"
  | "approval-expired"
  | "dispatched"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "indeterminate";

export interface ActionAuditEvent {
  eventId: string;
  actionId: string;
  actionDigest: string;
  principalId: string;
  runId: string;
  state: ActionState;
  timestamp: number;
  policyDigest: string;
  envelopeId?: string;
  reason?: PermissionDenyReason;
  backend?: import("./execution-boundary.js").ExecutionBackendCapabilities["backend"];
}

/**
 * Idempotency key is `actionId + state`. Effectful dispatch requires a durable
 * `dispatched` event before execution; terminal events use an idempotent
 * outbox so retry cannot repeat execution. A durable `dispatched` action
 * without a terminal record is recovered as `indeterminate`.
 */
export interface AuditStore {
  append(
    event: ActionAuditEvent,
    opts: { idempotencyKey: string },
  ): Promise<"written" | "duplicate">;
  getTerminal(actionId: string): Promise<ActionAuditEvent | undefined>;
}

/** Structural tool outcome used by hooks and transport events. */
export interface ToolOutcome {
  state:
    | "denied"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "expired"
    | "indeterminate";
  action: import("./prepared-action.js").PreparedToolAction;
  result?: import("../types.js").ToolResult;
  denial?: PermissionDenyReason;
  envelopeId?: string;
}

// Re-export shared vocab so consumers import from one place if desired.
export type {
  NetworkDestination,
  ExternalRecipient,
  JsonValue,
  FileSnapshot,
  CanonicalPathTarget,
};
