/**
 * Permission policy, capability, approval, and trace contracts — Foundations
 * (spec 008).
 *
 * The effective capability is a monotonic intersection:
 *
 *   deployment ceiling
 *     ∩ principal policy
 *     ∩ runtime baseline
 *     ∩ predeclared/session capabilities
 *     ∩ approved request
 *
 * Every term may narrow; no term may expand a term to its left. The engine
 * first applies immutable denies and backend support, then intersects the
 * remaining layers. Approval is offered only when the requested capability
 * is within the outer ceilings and the active broker can represent the
 * request. A `PolicyDecision` is a closed discriminated union.
 *
 * Foundations imports no Seepient layer.
 */

import type { PreparedToolAction } from "./prepared-action.js";
import type {
  ExecutionBackendCapabilities,
  ExecutionBoundary,
} from "./execution-boundary.js";
import type { ToolEffectKind } from "./tool-effects.js";

// ── Capabilities ────────────────────────────────────────────────────────

/**
 * A capability is the enforceable shape of one allowed effect. Shape and
 * lifetime are independent: a longer lifetime never widens an exact target
 * into a root or glob.
 */
export type Capability =
  | { kind: "read-root"; root: string }
  | { kind: "read-file"; path: string }
  | { kind: "write-root"; root: string }
  | { kind: "commit-file"; path: string }
  | {
      kind: "network-destination";
      scheme: "https" | "http";
      host: string;
      port?: number;
    }
  | { kind: "external-recipient"; service: string; recipient: string }
  | { kind: "process"; executable?: string; argvPrefix?: string[] }
  | { kind: "secret-ref"; ref: string }
  | { kind: "model-egress"; providerClass: string; dataClasses: string[] }
  | { kind: "activate-change-class"; changeClass: import("./self-evolution.js").SelfEvolutionChangeClass }
  | { kind: "trusted-host"; registrationId?: string };
/** When a capability is valid. Action-scoped caps are never persisted. */
export type CapabilityLifetime =
  | { kind: "action"; actionDigest: string; consumeOnce: true }
  | { kind: "run"; runId: string; expiresAt: number }
  | { kind: "session"; sessionId: string; expiresAt?: number }
  | { kind: "project"; workspaceId: string; expiresAt?: number }
  | { kind: "global"; expiresAt?: number };

export interface CapabilitySet {
  version: 1;
  capabilities: Capability[];
}

export interface DecisionAuthority {
  kind: "deployment" | "principal" | "human" | "service";
  authorityId: string;
  authenticatedBy: string;
}

/**
 * Capabilities bound to a principal/run/action plus provenance. Action-scoped
 * capabilities are bound to and consumed by one `actionDigest`; they are never
 * written to a general store.
 */
export interface CapabilityEnvelope {
  version: 1;
  envelopeId: string;
  principalId: string;
  runId: string;
  actionDigest: string;
  capabilities: Capability[];
  lifetime: CapabilityLifetime;
  issuedBy: DecisionAuthority;
  issuedAt: number;
  expiresAt?: number;
  policyDigest: string;
}

// ── Policy inputs and decision ──────────────────────────────────────────

export interface DenyRule {
  ruleId: string;
  effect: ToolEffectKind | "*";
  target?: string;
  reason: PermissionDenyReason;
}

export interface InteractionContract {
  mode: "inline" | "callback" | "none" | "durable-remote";
  deadlineMs?: number;
}

/**
 * Inputs to `PolicyEngine.evaluate`. The engine does not import capability
 * implementations; `backendCapabilities` is an immutable value describing
 * what the selected backend can enforce.
 */
export interface PolicyContext {
  deploymentCeiling: CapabilitySet;
  principalPolicy: CapabilitySet;
  runtimeBaseline: CapabilitySet;
  activeCapabilities: CapabilitySet;
  immutableDenies: DenyRule[];
  approvalMode: "manual" | "balanced" | "never";
  interaction: InteractionContract;
  backendCapabilities: ExecutionBackendCapabilities;
  /** The workspace root — interactive surfaces let users approve file
   *  operations within this root even when the ceiling is empty. Paths
   *  OUTSIDE this root are outside-ceiling (deny). */
  workspaceRoot?: string;
}

export interface PolicyTrace {
  policyDigest: string;
  evaluatedLayers: Array<{
    layer:
      | "immutable-deny"
      | "deployment"
      | "principal"
      | "runtime"
      | "active"
      | "backend";
    result: "allow" | "narrow" | "deny";
    ruleIds: string[];
  }>;
}

/** Machine-readable denial reasons; surfaces never infer from strings. */
export type PermissionDenyReason =
  | "immutable-deny"
  | "outside-ceiling"
  | "outside-principal"
  | "outside-runtime-baseline"
  | "backend-unsupported"
  | "approval-unavailable"
  | "approval-denied"
  | "approval-expired"
  | "invalid-approval-response"
  | "user-denied"
  | "audit-unavailable"
  | "model-egress-denied"
  | "secret-denied"
  | "security-activation-required"
  | "policy-conflict"
  | "unknown-tool"
  /** T107d: capability was consumed (action-scoped) or has expired (run/session). */
  | "capability-expired"
  /** T107d: capability was revoked before use (run/session revocation). */
  | "capability-revoked";

/**
 * Closed decision union. `needs-approval` carries the proposed envelope to
 * issue on approval; approval never widens the requested capability.
 */
export type PolicyDecision =
  | { decision: "allow"; envelope: CapabilityEnvelope; trace: PolicyTrace }
  | {
      decision: "needs-approval";
      request: PermissionRequest;
      proposedEnvelope: CapabilityEnvelope;
      trace: PolicyTrace;
    }
  | {
      decision: "deny";
      reason: PermissionDenyReason;
      message: string;
      trace: PolicyTrace;
    };

export interface PolicyEngine {
  evaluate(action: PreparedToolAction, context: PolicyContext): PolicyDecision;
}

// ── Approval ────────────────────────────────────────────────────────────

export interface PermissionRequest {
  requestId: string;
  principalId: string;
  runId: string;
  sessionId?: string;
  toolCallId: string;
  actionDigest: string;
  action: import("./prepared-action.js").ActionDisplay;
  requestedCapabilities: Capability[];
  offeredLifetimes: Array<"action" | "run" | "session">;
  createdAt: number;
  expiresAt: number;
}

export type PermissionDecision =
  | {
      approved: true;
      requestId: string;
      actionDigest: string;
      lifetime: "action" | "run" | "session";
      actorId: string;
      decidedAt: number;
    }
  | {
      approved: false;
      requestId: string;
      actionDigest: string;
      actorId: string;
      reason?: string;
      decidedAt: number;
    };

/**
 * Approval broker — surface-specific. The broker cannot change the requested
 * capability; persistent project/global changes use a separate administrative
 * `PolicyStore.compareAndSet()` flow.
 */
export interface ApprovalBroker {
  readonly mode: InteractionContract["mode"];
  request(
    req: PermissionRequest,
    opts: { signal?: AbortSignal },
  ): Promise<PermissionDecision>;
}

/**
 * Result of the policy/approval pipeline as seen by the action lifecycle.
 * `envelopeId` is set when an envelope was issued (allow path only).
 */
export interface ResolvedPolicyDecision {
  decision: PolicyDecision;
  approval?: PermissionDecision;
}

/** Re-exported so composition roots can pass an ExecutionBoundary value. */
export type { ExecutionBoundary, ExecutionBackendCapabilities };
