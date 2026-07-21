/**
 * PolicyEngine — Domain (spec 008, T106).
 *
 * One decision pipeline:
 *
 *   tool call
 *     → prepare immutable action
 *     → intersect policy (immutable denies, ceilings, backend support)
 *     → allow | needs-approval | deny
 *
 * Approval causes at most one reevaluation of the same prepared action with
 * the approved capability added to `activeCapabilities`. The engine first
 * applies immutable denies and backend support, then intersects the ceiling,
 * principal, baseline, and active capabilities.
 *
 * Pure (no I/O). Property-testable.
 */
import type {
  ApprovalBroker,
  Capability,
  CapabilityEnvelope,
  DenyRule,
  PolicyContext,
  PolicyDecision,
  PolicyEngine as PolicyEngineContract,
  PolicyTrace,
  PermissionRequest,
} from "../../foundations/contracts/permission-policy.js";
import type { PreparedToolAction } from "../../foundations/contracts/prepared-action.js";
import type { PreparedOperation } from "../../foundations/contracts/prepared-action.js";
import type { ToolEffectKind } from "../../foundations/contracts/tool-effects.js";
import { createHash } from "node:crypto";
import { generateId } from "../../foundations/id.js";
import {
  EMPTY_CAPABILITY_SET,
  effectiveCapabilities,
  isDeniedByRule,
  requiredCapabilities,
  setCovers,
} from "./capability-store.js";

/** Trace helpers keep the policy layer auditable without secret values. */
function emptyTrace(policyDigest: string): PolicyTrace {
  return { policyDigest, evaluatedLayers: [] };
}

function pushLayer(
  trace: PolicyTrace,
  layer: PolicyTrace["evaluatedLayers"][number]["layer"],
  result: "allow" | "narrow" | "deny",
  ruleIds: string[] = [],
): void {
  trace.evaluatedLayers.push({ layer, result, ruleIds });
}

/**
 * Effect kinds produced by a prepared operation (independent of the analyzer-
 * declared effects). Used so the engine can reason about what the operation
 * *does*, not just what the analyzer *says*.
 */
function operationEffects(op: PreparedOperation): ToolEffectKind[] {
  switch (op.kind) {
    case "none":
      return [];
    case "read-file":
      return ["filesystem-read"];
    case "commit-files":
      return ["filesystem-write"];
    case "process":
      return ["process-exec"];
    case "broker":
      if (op.request.kind === "http") return ["network-egress"];
      if (op.request.kind === "external-send") return ["external-send"];
      return ["secret-use"];
    case "trusted-host":
      // Host tools are application authority; the effect vocabulary is what
      // the analyzer declared, which is already in `action.effects`.
      return [];
  }
}

/** Build a `PermissionRequest` from a prepared action and missing capabilities. */
function buildPermissionRequest(
  action: PreparedToolAction,
  missing: Capability[],
  context: PolicyContext,
): PermissionRequest {
  const now = Date.now();
  const deadlineMs = context.interaction.deadlineMs ?? 30_000;
  return {
    requestId: generateId(),
    principalId: action.principalId,
    runId: action.runId,
    toolCallId: action.toolCallId,
    actionDigest: action.actionDigest,
    action: action.display,
    requestedCapabilities: missing,
    offeredLifetimes: ["action", "run"],
    createdAt: now,
    expiresAt: now + deadlineMs,
  };
}

/**
 * Build a proposed (action-scoped) envelope covering exactly the requested
 * capabilities. Never widens — only contains capabilities the engine intends
 * to issue on approval.
 */
function buildEnvelope(
  action: PreparedToolAction,
  capabilities: Capability[],
  policyDigest: string,
): CapabilityEnvelope {
  return {
    version: 1,
    envelopeId: generateId(),
    principalId: action.principalId,
    runId: action.runId,
    actionDigest: action.actionDigest,
    capabilities,
    lifetime: { kind: "action", actionDigest: action.actionDigest, consumeOnce: true },
    issuedBy: {
      kind: "service",
      authorityId: "policy-engine",
      authenticatedBy: "deployment",
    },
    issuedAt: Date.now(),
    policyDigest,
  };
}

/** Deny decision helper. */
function deny(
  reason: import("../../foundations/contracts/permission-policy.js").PermissionDenyReason,
  message: string,
  trace: PolicyTrace,
): PolicyDecision {
  return { decision: "deny", reason, message, trace };
}

/**
 * The Domain policy engine. `policyDigest` is computed by the caller (run
 * setup) from the canonical serialized context and threaded through every
 * decision for audit provenance.
 */
export class PolicyEngine implements PolicyEngineContract {
  private readonly policyDigest: string;

  constructor(policyDigest: string) {
    this.policyDigest = policyDigest;
  }

  evaluate(action: PreparedToolAction, context: PolicyContext): PolicyDecision {
    const trace = emptyTrace(this.policyDigest);

    // 1. Immutable denies — checked first, can never be overridden.
    const opEffects = operationEffects(action.operation);
    for (const effect of opEffects) {
      const rule = isDeniedByRule(
        context.immutableDenies,
        effect,
        this.firstTargetForEffect(action, effect),
      );
      if (rule) {
        pushLayer(trace, "immutable-deny", "deny", [rule.ruleId]);
        return deny("immutable-deny", `Immutable deny: ${rule.reason}`, trace);
      }
    }

    // 2. Backend support — never offer a capability the backend can't enforce.
    const opKind = action.operation.kind;
    if (
      opKind !== "none" &&
      !context.backendCapabilities.supportedOperationKinds.includes(opKind)
    ) {
      pushLayer(trace, "backend", "deny");
      return deny(
        "backend-unsupported",
        `Backend "${context.backendCapabilities.backend}" does not support operation "${opKind}"`,
        trace,
      );
    }

    // 3. Effective capabilities — monotonic intersection.
    const effective = effectiveCapabilities(
      context.deploymentCeiling,
      context.principalPolicy,
      context.runtimeBaseline,
      context.activeCapabilities,
    );
    const intersectionResult =
      effective.capabilities.length === context.activeCapabilities.capabilities.length
        ? "allow"
        : "narrow";
    pushLayer(trace, "deployment", effective.capabilities.length > 0 ? "narrow" : "deny");
    pushLayer(trace, "principal", intersectionResult);
    pushLayer(trace, "runtime", intersectionResult);
    pushLayer(trace, "active", intersectionResult);

    // 4. Required capabilities — every requested capability must be covered.
    const required = requiredCapabilities(action.effects);
    const missing = required.filter((c) => !setCovers(effective, c));

    if (missing.length === 0) {
      pushLayer(trace, "backend", "allow");
      // All effects covered — issue an action-scoped envelope for exactly the
      // required capabilities (no more).
      const envelope = buildEnvelope(action, required, this.policyDigest);
      return { decision: "allow", envelope, trace };
    }

    // 5. needs-approval — only if the interaction mode can represent it.
    if (context.interaction.mode === "none") {
      // Headless surfaces: typed denial immediately, never prompt.
      pushLayer(trace, "backend", "deny");
      return deny(
        "approval-unavailable",
        "Headless surface: missing capability and approval is unavailable",
        trace,
      );
    }

    if (context.approvalMode === "never") {
      pushLayer(trace, "backend", "deny");
      return deny(
        "approval-unavailable",
        "Approval mode is 'never' and a capability is missing",
        trace,
      );
    }

    // The missing capabilities must be within the OUTER ceilings; if they are
    // outside deployment/principal, approval cannot help — deny.
    const inCeiling = missing.every(
      (c) =>
        setCovers(context.deploymentCeiling, c) &&
        setCovers(context.principalPolicy, c),
    );
    if (!inCeiling) {
      pushLayer(trace, "deployment", "deny");
      return deny(
        "outside-ceiling",
        "Requested capability exceeds deployment or principal ceiling",
        trace,
      );
    }

    // Backend must also be able to enforce the missing capability shape.
    const backendSupports = missing.every((c) =>
      context.backendCapabilities.capabilityKinds.includes(c.kind),
    );
    if (!backendSupports) {
      pushLayer(trace, "backend", "deny");
      return deny(
        "backend-unsupported",
        "Selected backend cannot enforce one or more requested capabilities",
        trace,
      );
    }

    pushLayer(trace, "backend", "allow");
    const proposedEnvelope = buildEnvelope(action, missing, this.policyDigest);
    const request = buildPermissionRequest(action, missing, context);
    return {
      decision: "needs-approval",
      request,
      proposedEnvelope,
      trace,
    };
  }

  private firstTargetForEffect(
    action: PreparedToolAction,
    effect: ToolEffectKind,
  ): string | undefined {
    const req = action.effects.find((e) => e.kind === effect);
    if (!req) return undefined;
    switch (req.kind) {
      case "filesystem-read":
        return req.targets[0]?.canonicalPath;
      case "filesystem-write":
        return req.targets[0]?.target.canonicalPath;
      case "process-exec":
        return req.command.executable;
      case "network-egress":
        return req.destinations === "dynamic"
          ? undefined
          : req.destinations[0]?.host;
      case "external-send":
        return req.destinations[0]?.recipient;
      case "secret-use":
        return req.secretRefs[0];
      case "model-egress":
        return req.providerClass;
      case "security-policy-change":
        return req.proposalId;
      case "software-activation":
        return req.candidateId;
    }
  }
}

/** Convenience: compute a stable policy digest from a serialized context. */
export function computePolicyDigest(context: PolicyContext): string {
  // Deterministic JSON serialization (sorted keys) for cross-process stability.
  const canonical = JSON.stringify(context, Object.keys(context).sort());
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export { EMPTY_CAPABILITY_SET };
export type { ApprovalBroker };
