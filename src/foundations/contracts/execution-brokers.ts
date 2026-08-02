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
 * Trusted provenance for a model-egress authorization. Built by the Domain
 * agent loop from immutable prepared-action data — NOT from caller-supplied
 * labels. `originDataClasses` are the authoritative classification: they
 * combine the analyzer-declared `model-egress` effect classes (origin-derived)
 * with the call-site classifier's verdict on the actual output bytes, which can
 * only ESCALATE (never downgrade). A caller cannot inject or soften these.
 *
 * `actionDigest` binds the decision to the exact approved action; `sourceArtifact`
 * (when the output came from a broker/content-addressed store) lets the gate
 * verify the artifact belongs to this action.
 */
export interface ModelEgressProvenance {
  /** The digest of the prepared action whose output is being released. */
  actionDigest: string;
  /** The provider trust class for the configured model provider. */
  providerClass: string;
  /**
   * Origin-derived data classes, taken from the action's `model-egress` effect
   * declarations and escalated by the call-site classifier. The gate treats
   * this list as the only authoritative classification.
   */
  originDataClasses: string[];
  /** Content-addressed artifact the output was read from, if any. */
  sourceArtifact?: PreparedArtifactRef;
}

/**
 * Invoked before tool output enters model-visible history or is sent to a
 * provider. Secret-class data, active policy, approval credentials, release
 * keys, and control-plane credentials are immutable denies. Local/on-device
 * providers still pass through the gate with an explicit provider class.
 *
 * The decision is derived SOLELY from `provenance` (trusted) + the envelope.
 * Caller-supplied classifications are not accepted.
 */
export interface ModelEgressGate {
  authorize(
    provenance: ModelEgressProvenance,
    envelope: CapabilityEnvelope,
  ): Promise<ModelEgressDecision>;
}

// ── Protected policy store ──────────────────────────────────────────────

export interface PolicySnapshot {
  workspaceId: string;
  version: number;
  policyDigest: string;
  policy: CapabilitySet;
  /** Forensic record (P0 review fix): who performed the last mutation and
   *  when. Populated by LocalPolicyStore on every compare-and-set. */
  grantedBy?: import("./permission-policy.js").DecisionAuthority;
  grantedAt?: number;
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
  | "policy-grant-intent"
  | "policy-granted"
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
  /** Forensic fields for approvals (spec 011): the selected option/lifetime,
   *  the granting actor, the granted capability set, and — for persistent
   *  project/global choices — the protected-policy versions before and after
   *  the compare-and-set mutation and the workspace the grant targets.
   *  The pre-CAS `approved` event carries `policyBeforeVersion`; the
   *  post-CAS `policy-granted` event carries `policyAfterVersion` and the
   *  granted workspace. This makes "who granted what, when, at which policy
   *  version" durably reconstructable even if a later dispatch fails. */
  optionId?: string;
  lifetime?: "action" | "run" | "session" | "project" | "global";
  capabilities?: import("./permission-policy.js").Capability[];
  actorId?: string;
  policyBeforeVersion?: number;
  policyAfterVersion?: number;
  grantedWorkspaceId?: string;
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
