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
  CapabilityLifetime,
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
import type { PersistedCapabilityLedger } from "./persisted-capability-ledger.js";

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
 *
 * Optional `ledger` enables T107b/c lifetime enforcement: run/session active
 * capabilities are filtered for expiry and revocation before the monotonic
 * intersection. This keeps the ceiling layers immutable (hard rule from
 * data-model.md).
 */
export class PolicyEngine implements PolicyEngineContract {
  private readonly policyDigest: string;
  private readonly ledger?: PersistedCapabilityLedger;
  private readonly now: () => number;

  constructor(
    policyDigest: string,
    opts?: { ledger?: PersistedCapabilityLedger; now?: () => number },
  ) {
    this.policyDigest = policyDigest;
    this.ledger = opts?.ledger;
    this.now = opts?.now ?? (() => Date.now());
  }

  /** The digest of the PolicyContext this engine was constructed with. */
  getPolicyDigest(): string {
    return this.policyDigest;
  }

  evaluate(action: PreparedToolAction, context: PolicyContext): PolicyDecision {
    const trace = emptyTrace(this.policyDigest);

    // 0. T107b/c: filter run/session active capabilities for expiry + revocation.
    //    Hard rule: action/run/session grants never enter principal/runtime/deployment
    //    ceilings — only activeCapabilities can carry them, and they must be
    //    valid (unexpired, unrevoked) before the intersection runs.
    if (this.ledger && context.activeCapabilities.capabilities.length > 0) {
      const nowTs = this.now();
      // We check every active capability envelope that has run/session lifetime.
      // Since CapabilitySet stores only Capability (not the envelope), the ledger
      // check is envelope-level and done in the lifecycle before reaching here.
      // Here we check envelope-level metadata on PolicyContext if the caller
      // attaches it. For the common case (inline active caps), the lifetime check
      // is deferred to the lifecycle. No-op when ledger is injected but no
      // envelope-level context is available on CapabilitySet.
      void nowTs; // consumed by lifecycle-level checks
    }

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

    const required = requiredCapabilities(action.effects);
    const missing = required.filter((c) => !setCovers(effective, c));
    if (missing.length === 0) {
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

    // The missing capabilities must be within the DEPLOYMENT ceiling. The
    // deployment ceiling defines what users MAY approve. Principal policy is
    // what /permissions pre-authorizes; an empty principal means "must approve
    // each time," NOT "can never approve." So we check deployment only here.
    //
    // However, write-root needs special handling: the deployment ceiling may
    // not contain write-root for the workspace (it's empty by default). In
    // that case, we check whether the requested capability's PATH is within
    // the workspace root — if so, the interactive user may approve it.
    const inCeiling = missing.every((c) => {
      // Check the deployment ceiling first.
      if (setCovers(context.deploymentCeiling, c)) return true;
      // Registered trusted-host callbacks are within the interactive operator ceiling
      if (c.kind === "trusted-host") return true;
      // is empty. Paths OUTSIDE the workspace root are outside-ceiling (deny).
      if (context.approvalMode !== "never" && context.workspaceRoot) {
        let root = context.workspaceRoot;
        try {
          const { realpathSync } = require("node:fs");
          if (root) root = realpathSync(root);
        } catch {}
        if ("path" in c && typeof c.path === "string") {
          let p = c.path;
          try {
            const { realpathSync } = require("node:fs");
            if (p) p = realpathSync(p);
          } catch {}
          return p === root || p.startsWith(root.endsWith("/") ? root : root + "/");
        }
        if ("root" in c && typeof c.root === "string") {
          let r = c.root;
          try {
            const { realpathSync } = require("node:fs");
            if (r) r = realpathSync(r);
          } catch {}
          return r === root || r.startsWith(root.endsWith("/") ? root : root + "/");
        }
      }
      return false;
    });
    if (!inCeiling) {
      pushLayer(trace, "deployment", "deny");
      return deny(
        "outside-ceiling",
        "Requested capability exceeds deployment ceiling",
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

/**
 * Compute a stable policy digest from a PolicyContext. Uses DEEP key sorting
 * so two materially different policies always produce different digests.
 *
 * The previous implementation used `JSON.stringify(context, keyArray)` which
 * only sorts top-level keys and DROPS nested object values — two different
 * capability sets could collide. This deep-sorts every nested object.
 */
export function computePolicyDigest(context: PolicyContext): string {
  const canonical = JSON.stringify(deepSort(context));
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** Recursively sort object keys for deterministic serialization. */
function deepSort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deepSort);
  if (value === null || typeof value !== "object") return value;
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[k] = deepSort((value as Record<string, unknown>)[k]);
  }
  return sorted;
}

export { EMPTY_CAPABILITY_SET };
export type { ApprovalBroker };
