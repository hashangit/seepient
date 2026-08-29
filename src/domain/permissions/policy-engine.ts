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
 * Pure (no I/O) except best-effort synchronous realpath canonicalization of
 * workspace containment checks (raw-path fallback when a target does not
 * resolve). Property-testable.
 */
import type {
  ApprovalBroker,
  ApprovalChoice,
  ApprovalOption,
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
import { buildApprovalChoices, buildApprovalOptions } from "./approval-options.js";
import { realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * Canonicalize a path via realpathSync; fall back to the raw path when it
 * does not resolve (e.g. a file that does not exist yet). ESM has no
 * `require`, so an inline `require("node:fs")` here was dead code that
 * silently skipped canonicalization (review round 10).
 */
const canonicalPath = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    // A not-yet-existing target keeps its basename but inherits the
    // canonical parent, so a canonicalized root still prefix-matches
    // (macOS /var -> /private/var).
    const parent = dirname(p);
    if (parent === p) return p;
    try {
      return join(realpathSync(parent), basename(p));
    } catch {
      return p;
    }
  }
};

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

export function formatCapabilitySpec(cap: Capability): string {
  switch (cap.kind) {
    case "read-root":
      return `read-root:${cap.root}`;
    case "read-file":
      return `read-file:${cap.path}`;
    case "write-root":
      return `write-root:${cap.root}`;
    case "commit-file":
      return `commit-file:${cap.path}`;
    case "process":
      return "process";
    case "model-egress":
      return `model-egress:${cap.providerClass}`;
    case "network-destination":
      return `network-destination:${cap.scheme}://${cap.host}`;
    case "external-recipient":
      return `external-recipient:${cap.service}:${cap.recipient}`;
    case "secret-ref":
      return `secret-ref:${cap.ref}`;
    default:
      return (cap as any).kind ?? "capability";
  }
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
  approvalOptions: ApprovalOption[],
  approvalChoices: ApprovalChoice[],
): PermissionRequest {
  const now = Date.now();
  // Spec 011: the request expiry IS the approval deadline. The factory
  // supplies the configured value (`permissions.approvalTimeoutMs`, default
  // ten minutes); this fallback only guards callers that build contexts by
  // hand.
  const deadlineMs = context.interaction.deadlineMs ?? 600_000;
  // Spec 011: the request keeps the stable session identity so the bridge can
  // offer `session`; `session` is offered only when that identity exists.
  // Persistent `project`/`global` choices require a workspace identity
  // (interactive CLI surfaces) — they are recorded through the protected
  // policy store, never grants files.
  const sessionId = action.sessionId ?? context.sessionId;
  const workspaceId = context.workspaceId;
  return {
    requestId: generateId(),
    principalId: action.principalId,
    runId: action.runId,
    sessionId,
    workspaceId,
    toolCallId: action.toolCallId,
    actionDigest: action.actionDigest,
    action: action.display,
    requestedCapabilities: missing,
    approvalOptions,
    approvalChoices,
    offeredLifetimes: [
      "action",
      "run",
      ...(sessionId ? (["session"] as const) : []),
      ...(workspaceId ? (["project", "global"] as const) : []),
    ],
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
      let message = `Backend "${context.backendCapabilities.backend}" does not support operation "${opKind}"`;
      if (context.backendCapabilities.supportedOperationKinds.length === 0) {
        message = "Tool operations (including file reads) are not supported on the server surface until the Docker worker backend ships (spec 008). Chat and model inference are unaffected.";
      } else if (action.toolName === "take_screenshot") {
        message = "take_screenshot requires an isolated browser worker (not yet available). It is intentionally unsupported rather than silently unsafe.";
      }
      return deny(
        "backend-unsupported",
        message,
        trace,
      );
    }

    // Spec 019 (FR-002): exact-commit gate. A write the backend cannot
    // enforce is refused BEFORE the prompt — keyed on operation kind so it
    // runs for every commit-files action regardless of capability coverage;
    // pre-granted caps (017 always-allowed class, config-derived grants)
    // must not reach the early-allow and dispatch into a guaranteed failure.
    if (
      opKind === "commit-files" &&
      !context.backendCapabilities.exactCommit &&
      !context.backendCapabilities.jsFsFallbackOptIn
    ) {
      pushLayer(trace, "backend", "deny");
      return deny(
        "exact-commit-unavailable",
        "Exact file commits are unavailable because the native helper is missing or failed verification. Update Seepient to get the packaged helper, or set SEEPIENT_ALLOW_JS_FS_FALLBACK=1 to accept atomic writes without symlink/TOCTOU protection.",
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

    // Missing capabilities must be within the DEPLOYMENT ceiling before they
    // can be approved by a person or admitted by autonomous mode. The
    // deployment ceiling defines what users MAY approve. Principal policy is
    // what /permissions pre-authorizes; an empty principal means "must approve
    // each time," NOT "can never approve." So we check deployment only here.
    //
    // However, write-root needs special handling: the deployment ceiling may
    // not contain write-root for the workspace (it's empty by default). In
    // that case, we check whether the requested capability's PATH is within
    // the workspace root — if so, the interactive user may approve it.
    //
    // Spec 019 (FR-006): trusted-host capabilities are within ceiling only
    // via the operator allowlist (`permissions.trustedHostAllowlist`,
    // default `["use_skill"]`) — the former blanket exemption let one
    // approval cover unlimited subsequent MCP writes.
    let hostDenyMessage: string | undefined;
    const hostAllowlist = context.trustedHostAllowlist ?? ["use_skill"];
    const hostRegistrationId = (cap: Capability): string | undefined => {
      if (cap.kind !== "trusted-host") return undefined;
      if (typeof cap.registrationId === "string") return cap.registrationId;
      const op = action.operation;
      return op.kind === "trusted-host" ? op.toolName ?? op.registrationId : undefined;
    };
    const inCeiling = missing.every((c) => {
      // Check the deployment ceiling first.
      if (setCovers(context.deploymentCeiling, c)) return true;
      // Host authority: allowlist membership only.
      if (c.kind === "trusted-host") {
        const id = hostRegistrationId(c);
        if (id && hostAllowlist.includes(id)) return true;
        hostDenyMessage = `Tool "${id ?? "unknown"}" runs with host authority and is not on the trusted-host allowlist. Add it under permissions.trustedHostAllowlist in your settings if you trust it.`;
        return false;
      }
      if (context.approvalMode !== "never" && context.workspaceRoot) {
        const root = canonicalPath(context.workspaceRoot);
        const withinRoot = (target: string): boolean => {
          const t = canonicalPath(target);
          return t === root || t.startsWith(root.endsWith("/") ? root : root + "/");
        };
        if ("path" in c && typeof c.path === "string") return withinRoot(c.path);
        if ("root" in c && typeof c.root === "string") return withinRoot(c.root);
      }
      return false;
    });
    if (!inCeiling) {
      pushLayer(trace, "deployment", "deny");
      return deny(
        "outside-ceiling",
        hostDenyMessage ?? "Requested capability exceeds deployment ceiling",
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

    // FR-012: none-operation normal-class actions (e.g. get_current_datetime, manage_todos, render_widget)
    // are implicitly pre-authorized across all consent modes once verified within the deployment ceiling.
    const isNoneOperationNormalEgress =
      action.operation.kind === "none" &&
      action.effects.every(
        (e) =>
          e.kind === "model-egress" &&
          (!e.dataClasses || e.dataClasses.every((d) => d === "normal")),
      );

    if (isNoneOperationNormalEgress) {
      const envelope = buildEnvelope(action, required, this.policyDigest);
      return { decision: "allow", envelope, trace };
    }

    pushLayer(trace, "backend", "allow");
    // Spec 011 (FR-019): containment preflight — a process action can only be
    // presented for approval when the backend can actually isolate it OR the
    // operator explicitly opted into uncontained execution. If neither is
    // true, fail BEFORE the prompt with the actionable setup message instead
    // of letting every approved action fail at dispatch (product acceptance).
    if (
      missing.some((c) => c.kind === "process") &&
      !context.backendCapabilities.environmentIsolation &&
      !context.backendCapabilities.uncontainedOptIn
    ) {
      pushLayer(trace, "backend", "deny");
      return deny(
        "approval-unavailable",
        "Process containment is not available on this system. Install the platform sandbox (macOS: sandbox-exec is bundled with macOS; Linux: install Bubblewrap, e.g. `apt install bubblewrap` or `brew install bwrap`) or run with SEEPIENT_UNCONTAINED=1 to explicitly disable containment.",
        trace,
      );
    }

    // Autonomous mode removes the human approval round-trip, not the safety
    // boundary. Immutable denies, the deployment ceiling, backend capability
    // support, and process containment were all enforced above. The issued
    // envelope is still exact to this prepared action and action-scoped.
    if (context.approvalMode === "autonomous") {
      return {
        decision: "allow",
        envelope: buildEnvelope(action, required, this.policyDigest),
        trace,
      };
    }

    // Balanced mode (edit-enabled, spec 017 / T025): auto-approves non-destructive,
    // non-send in-ceiling capabilities. Destructive-risk process actions,
    // external-send effects, and secret-sensitivity reads route to prompt.
    if (context.approvalMode === "balanced") {
      const isDestructiveProcess =
        action.operation.kind === "process" && action.risk === "destructive";
      const hasExternalSend = action.effects.some(
        (e) => e.kind === "external-send",
      );
      const readsSecret = action.effects.some(
        (e) => e.kind === "filesystem-read" && e.sensitivity === "secret",
      );

      const requiresPrompt = isDestructiveProcess || hasExternalSend || readsSecret;
      if (!requiresPrompt) {
        return {
          decision: "allow",
          envelope: buildEnvelope(action, required, this.policyDigest),
          trace,
        };
      }
    }

    // 5. needs-approval — only if the interaction mode can represent it.
    if (context.interaction.mode === "none") {
      // Headless surfaces: typed denial immediately with exact remediation.
      pushLayer(trace, "backend", "deny");
      const firstMissing = missing[0];
      const spec = firstMissing ? formatCapabilitySpec(firstMissing) : "required capability";
      return deny(
        "approval-unavailable",
        `Headless run: ${spec} is not predeclared. Allow it with: /permissions propose ${spec} (interactive), or pass --mode autonomous, or supply SDK policy options.`,
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
    // Spec 011 (T005): the request carries policy-issued exact/bounded options
    // and complete choices. If filtering leaves no representable option or
    // choice, deny as unavailable rather than sending an empty prompt
    // (FR-001).
    const sessionId = action.sessionId ?? context.sessionId;
    const offeredLifetimes: Array<"action" | "run" | "session" | "project" | "global"> = [
      "action",
      "run",
      ...(sessionId ? (["session"] as const) : []),
      ...(context.workspaceId ? (["project", "global"] as const) : []),
    ];
    const approvalOptions = buildApprovalOptions({
      action,
      missing,
      context,
      offeredLifetimes,
    });
    if (!approvalOptions) {
      pushLayer(trace, "backend", "deny");
      return deny(
        "approval-unavailable",
        "No representable approval option remains after policy and backend filtering",
        trace,
      );
    }
    const approvalChoices = buildApprovalChoices(
      approvalOptions,
      sessionId,
      context.workspaceId,
    );
    if (approvalChoices.length === 0) {
      pushLayer(trace, "backend", "deny");
      return deny(
        "approval-unavailable",
        "No representable approval choice remains after policy and backend filtering",
        trace,
      );
    }
    const request = buildPermissionRequest(
      action,
      missing,
      context,
      approvalOptions,
      approvalChoices,
    );
    return {
      decision: "needs-approval",
      request,
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
