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

import type { ActionDisplay, PreparedToolAction } from "./prepared-action.js";
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
  | {
      kind: "process";
      executable?: string;
      argvPrefix?: string[];
      /**
       * Exact-argv mode (P0 review fix): when true, coverage requires the
       * SAME token count and tokens — an approval for `rm safe.txt` must not
       * cover `rm safe.txt other.txt`. Bounded/prefix options omit this flag.
       * Analyzer-emitted required process capabilities always set it.
       */
      argvExact?: boolean;
    }
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
  /**
   * Atomic transaction marker (round 6 P0): the persistent-grant WAL writes
   * a unique mutation ID into the stored policy in the SAME compare-and-set
   * that installs the capabilities.
   */
  mutationId?: string;
  /**
   * Append-only per-mutation journal INSIDE the policy snapshot (round 7
   * P0): every persistent-grant compare-and-set appends
   * `{ mutationId, version }` here, so the store itself proves WHICH
   * mutations were installed — even when later mutations overwrite
   * `mutationId`. Startup reconciliation requires the intent's ID to appear
   * in this history (or to be the latest `mutationId`); version-plus-
   * capability inference is never used.
   */
  mutationHistory?: Array<{ mutationId: string; version: number }>;
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
  /** Stable application-session identity. When set, PolicyEngine may offer
   *  the `session` lifetime for TUI approval (spec 011). */
  sessionId?: string;
  /**
   * Protected-policy workspace identity (project scope). When set, the
   * engine may offer persistent `project`/`global` approval choices — they
   * are recorded through `PolicyStore.compareAndSet`, never grants files.
   */
  workspaceId?: string;
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
 * Closed decision union. `needs-approval` carries the immutable request and
 * its policy-issued options — there is no single unconditional proposed
 * envelope, because the final capability set and lifetime are chosen only
 * after the broker response is validated (spec 011, D4). Approval never
 * widens the requested capability.
 */
export type PolicyDecision =
  | { decision: "allow"; envelope: CapabilityEnvelope; trace: PolicyTrace }
  | {
      decision: "needs-approval";
      request: PermissionRequest;
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

/**
 * Policy-issued capability choice the TUI may offer. The capability set,
 * not the label, is authoritative: labels are display data and are never
 * parsed to recover authority (spec 011 FR-007).
 */
export type ApprovalOptionKind = "exact" | "bounded";

export interface ApprovalOption {
  /** Stable within the request; derived from canonical option data. */
  optionId: string;
  /** Must equal the parent request digest. */
  actionDigest: string;
  kind: ApprovalOptionKind;
  /** Plain-language display text; never parsed as authority. */
  label: string;
  /** Canonical, backend-enforceable, policy-approved capabilities. */
  capabilities: Capability[];
  /** Non-empty subset of the parent request's offered lifetimes. */
  supportedLifetimes: Array<"action" | "run" | "session" | "project" | "global">;
}

/**
 * Transient UI selection — NOT an authority decision. The prompt emits only
 * the selected choice ID; the trusted broker resolves it against the
 * immutable request and supplies request identity, actor, and decision time
 * (spec 011 FR-004). The UI never combines scope and lifetime itself.
 */
export type TuiApprovalSelection =
  | { approved: true; choiceId: string }
  | { approved: false; reason?: "user-denied" | "approval-unavailable" };

/**
 * A complete, Domain-issued approval outcome: one scope option paired with
 * one lifetime, plus end-user copy derived from the option's capability
 * delta (spec 011 FR-007/FR-010). The TUI selects a choice; it never
 * constructs one.
 */
export interface ApprovalChoice {
  /** Stable within the request; derived from option ID + lifetime. */
  choiceId: string;
  /** Names one option in the same request. */
  optionId: string;
  /**
   * MVP: action or session; project/global are persistent choices that
   * write the PROTECTED policy store via compare-and-set (never grants
   * files). Bounded/action is never issued (FR-010).
   */
  lifetime: "action" | "session" | "project" | "global";
  /** Short consent headline, e.g. "Allow this action once". */
  title: string;
  /** What Seepient will ask again or remember (plain language). */
  description: string;
  /** One plain-language line per material authority in the delta. */
  authoritySummary: string[];
  /** Least-privileged valid choice (exact/action). Never preselected. */
  recommended: boolean;
}

export interface PermissionRequest {
  requestId: string;
  principalId: string;
  runId: string;
  /** Present only when a stable session identity can bind a session lifetime. */
  sessionId?: string;
  toolCallId: string;
  actionDigest: string;
  action: ActionDisplay;
  requestedCapabilities: Capability[];
  /** Policy-issued options; a request with no options cannot be approved. */
  approvalOptions: ApprovalOption[];
  /**
   * Complete Domain-issued choices. A native request with no choices
   * cannot be approved — the surface fails as `approval-unavailable`.
   */
  approvalChoices: ApprovalChoice[];
  offeredLifetimes: Array<"action" | "run" | "session" | "project" | "global">;
  /**
   * The protected-policy workspace identity. Present on interactive CLI
   * requests so project/global (persistent) choices can be issued and
   * recorded via `PolicyStore.compareAndSet`.
   */
  workspaceId?: string;
  createdAt: number;
  expiresAt: number;
}

export type PermissionDecision =
  | {
      approved: true;
      requestId: string;
      actionDigest: string;
      /** Names one option in the answered request (spec 011 FR-003). */
      optionId: string;
      lifetime: "action" | "run" | "session" | "project" | "global";
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
