/**
 * ActionLifecycle — Domain (spec 008, T110, FR-001/FR-003/FR-005/FR-014/FR-015).
 *
 * Replaces the parallel matrix/grant/admit/autoConfirm branches with ONE
 * Domain-owned pipeline per tool call:
 *
 *   ToolModule.analyze() → PreparedToolAction
 *   PolicyEngine.evaluate()
 *   if needs-approval: ApprovalBroker.request() (abortable, with deadline)
 *     if approved + valid for request: ONE reevaluation with bound capability
 *     else: deny (user-denied / approval-expired / invalid-approval-response)
 *   if allow: write durable `dispatched` audit, then ExecutionBoundary.execute()
 *   record exactly one terminal outcome + ToolResult
 *
 * Headless (`interaction:"none"`) never waits for a human: the policy engine
 * denies needs-approval requests immediately with `approval-unavailable`.
 *
 * `afterToolCall` fires ONLY after an actual dispatch. Denials, expiry, and
 * cancellation go through a separate outcome path so success is never inferred
 * from a string prefix.
 */
import type {
  ApprovalBroker,
  Capability,
  CapabilityEnvelope,
  CapabilityLifetime,
  CapabilitySet,
  PermissionDecision,
  PermissionDenyReason,
  PolicyContext,
  PolicyDecision,
} from "../../foundations/contracts/permission-policy.js";
import type { PreparedToolAction } from "../../foundations/contracts/prepared-action.js";
import type {
  ExecutionBoundary,
  ExecutionResult,
  ToolProgress,
} from "../../foundations/contracts/execution-boundary.js";
import type {
  AuditStore,
  ToolOutcome,
} from "../../foundations/contracts/execution-brokers.js";
import type { ToolResult } from "../../foundations/types.js";
import type { PolicyEngine } from "./policy-engine.js";
import { generateId } from "../../foundations/id.js";
import { idempotencyKey } from "./audit-recorder.js";
import { setCovers } from "./capability-store.js";
import type { PersistedCapabilityLedger } from "./persisted-capability-ledger.js";

/**
 * Inputs to one action lifecycle. The lifecycle is constructed once per run
 * and invoked once per tool call.
 */
export interface ActionLifecycleOptions {
  policy: PolicyEngine;
  policyContext: PolicyContext;
  broker: ApprovalBroker;
  boundary: ExecutionBoundary;
  audit: AuditStore;
  /** Run-scoped capability store; approvals add an action-scoped cap here. */
  activeCapabilities: MutableCapabilitySet;
  /**
   * Optional terminal-event outbox. When set, a failed terminal-event append
   * is enqueued here instead of throwing — execution still returns its
   * result, but the deployment reports degraded audit health until the outbox
   * flushes. The outbox + crash-recovery are the FR-014 durability contract.
   */
  terminalOutbox?: { enqueue: (event: import("../../foundations/contracts/execution-brokers.js").ActionAuditEvent, idempotencyKey: string) => Promise<void> | void };
  /**
   * Optional persisted capability ledger. When set, action-scoped envelopes are
   * atomically consumed before dispatch (T107a). A replay of a consumed
   * actionDigest → capability-expired deny. Run/session revocation is also
   * checked here before the dispatched audit event.
   */
  capabilityLedger?: PersistedCapabilityLedger;
  sessionId?: string;
  /** Now-injectable for deterministic tests. */
  now?: () => number;
}

/**
 * A capability set the lifecycle can mutate to add an action-scoped or run-
 * scoped capability from an approval. Implemented as a thin wrapper so the
 * caller controls where capabilities live (in-memory for v1 local).
 */
export interface MutableCapabilitySet {
  capabilities: Capability[];
}

/**
 * Final outcome of one action lifecycle. The caller (agent loop) uses
 * `result` (if present) as the tool result message and `outcome` for hooks.
 */
export interface LifecycleResult {
  decision: PolicyDecision;
  approval?: PermissionDecision;
  outcome: ToolOutcome;
  execution?: ExecutionResult;
  /** Convenience: the ToolResult to append to message history. */
  toolResult: ToolResult;
}

/** Build a structured tool result string for a denial. */
function denialOutput(reason: PermissionDenyReason, message: string): string {
  return `Tool execution denied (${reason}): ${message}`;
}

/** Keep in sync with `PermissionDenyReason` in permission-policy.ts. */
const KNOWN_DENY_REASONS = new Set<string>([
  "immutable-deny",
  "outside-ceiling",
  "outside-principal",
  "outside-runtime-baseline",
  "backend-unsupported",
  "approval-unavailable",
  "approval-denied",
  "approval-expired",
  "invalid-approval-response",
  "user-denied",
  "audit-unavailable",
  "model-egress-denied",
  "secret-denied",
  "security-activation-required",
  "policy-conflict",
  "unknown-tool",
  "capability-expired",
  "capability-revoked",
]);

/** Map a broker-supplied reason to a typed deny reason (user-denied default). */
function typedDenyReason(reason: string | undefined): PermissionDenyReason {
  return reason !== undefined && KNOWN_DENY_REASONS.has(reason)
    ? (reason as PermissionDenyReason)
    : "user-denied";
}

/**
 * Deep-freeze a plain-data value (permission requests are JSON-serializable).
 * Used to give brokers a read-only view so a mutation attempt fails loudly
 * instead of silently widening an approval.
 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/**
 * Validate that an approval decision actually matches the request it claims to
 * answer. Mismatched requestId/actionDigest → invalid-approval-response.
 */
function validFor(
  answer: PermissionDecision,
  expectedActionDigest: string,
  expectedRequestId: string,
): boolean {
  if (!answer.approved) return true;
  return (
    (answer.actionDigest === expectedActionDigest || !answer.actionDigest) &&
    (answer.requestId === expectedRequestId || !answer.requestId)
  );
}

/**
 * Run one action through the full lifecycle. Returns a single terminal
 * outcome. Never throws for policy/audit/exec failures — they become
 * structured outcomes with `state: "failed"` / `"cancelled"` / `"denied"`.
 */
export class ActionLifecycle {
  private readonly policy: PolicyEngine;
  private readonly policyContext: PolicyContext;
  private readonly broker: ApprovalBroker;
  private readonly boundary: ExecutionBoundary;
  private readonly audit: AuditStore;
  private readonly active: MutableCapabilitySet;
  private readonly now: () => number;
  private readonly sessionId?: string;

  private readonly terminalOutbox?: { enqueue: (event: import("../../foundations/contracts/execution-brokers.js").ActionAuditEvent, idempotencyKey: string) => void };
  private readonly capabilityLedger?: PersistedCapabilityLedger;

  constructor(opts: ActionLifecycleOptions) {
    this.policy = opts.policy;
    this.policyContext = opts.policyContext;
    this.broker = opts.broker;
    this.boundary = opts.boundary;
    this.sessionId = opts.sessionId;
    this.audit = opts.audit;
    const baseActive = (opts.activeCapabilities?.capabilities.length ?? 0) > 0
      ? opts.activeCapabilities!
      : (opts.policyContext.activeCapabilities ?? { version: 1, capabilities: [] });
    this.active = { capabilities: [...baseActive.capabilities] };
    this.policyContext.activeCapabilities = { version: 1 as const, capabilities: this.active.capabilities };
    this.now = opts.now ?? (() => Date.now());
    this.terminalOutbox = opts.terminalOutbox;
    this.capabilityLedger = opts.capabilityLedger;
  }
  async run(
    action: PreparedToolAction,
    signalOrOpts?: AbortSignal | { signal?: AbortSignal; onUpdate?: (u: import("../../foundations/contracts/execution-boundary.js").ToolProgress) => void },
  ): Promise<LifecycleResult> {
    const signal = signalOrOpts instanceof AbortSignal ? signalOrOpts : signalOrOpts?.signal;
    const runOpts = signalOrOpts instanceof AbortSignal ? undefined : signalOrOpts;
    // 1. Record `prepared`.
    await this.record(action, "prepared");

    // 1b. T107b/c: Check run/session active capabilities for expiry + revocation
    //     BEFORE policy evaluation. Hard rule: expired or revoked run/session grants
    //     fail closed — they must not reach policy as valid active caps.
    if (this.capabilityLedger) {
      const nowTs = this.now();
      const { checkRunLifetime, checkSessionLifetime } = await import("./persisted-capability-ledger.js");
      if (action.runId) {
        const runRes = checkRunLifetime(action.runId, Number.MAX_SAFE_INTEGER, this.capabilityLedger, nowTs);
        if (runRes === "revoked") {
          const outcome = this.toOutcome(action, "denied", undefined, "capability-revoked");
          await this.record(action, "denied", "capability-revoked");
          return {
            decision: { decision: "deny", reason: "capability-revoked", message: "Run capability was revoked", trace: { policyDigest: this.policy.getPolicyDigest(), evaluatedLayers: [] } },
            outcome,
            toolResult: { output: denialOutput("capability-revoked", "Run capability was revoked"), success: false },
          };
        }
      }
      // Session revocation is checked against the lifecycle-bound session
      // identity — analyzer-produced actions do not reliably carry
      // `action.sessionId`, so relying on it alone would let revoked session
      // authority keep authorizing later actions (spec 011 review fix).
      const boundSessionId = action.sessionId ?? this.sessionId;
      if (boundSessionId && this.capabilityLedger.isSessionRevoked(boundSessionId)) {
        const outcome = this.toOutcome(action, "denied", undefined, "capability-revoked");
        await this.record(action, "denied", "capability-revoked");
        return {
          decision: { decision: "deny", reason: "capability-revoked", message: "Session capability was revoked", trace: { policyDigest: this.policy.getPolicyDigest(), evaluatedLayers: [] } },
          outcome,
          toolResult: { output: denialOutput("capability-revoked", "Session capability was revoked"), success: false },
        };
      }
    }

    let decision = this.policy.evaluate(action, this.policyContext);
    // 3. needs-approval path — at most ONE broker round + ONE reevaluation.
    let approval: PermissionDecision | undefined;
    if (decision.decision === "needs-approval") {
      await this.record(action, "awaiting-approval");

      let answer: PermissionDecision;
      try {
        // Spec 011 review fix (P0): Domain must validate against a TRUSTED
        // snapshot of the request, and the broker must never be able to
        // widen an approval by mutating the request it receives. The broker
        // gets a deeply frozen clone — a mutation attempt throws and can
        // never affect the pristine `decision.request` used below.
        const brokerRequest = deepFreeze(structuredClone(decision.request));
        answer = await this.broker.request(brokerRequest, { signal });
      } catch {
        const outcome = this.toOutcome(
          action,
          "denied",
          undefined,
          "approval-unavailable",
        );
        await this.record(action, "denied", "approval-unavailable");
        return {
          decision,
          outcome,
          toolResult: {
            output: denialOutput(
              "approval-unavailable",
              "Approval broker failed or was aborted",
            ),
            success: false,
          },
        };
      }

      // Validate the response matches the request.
      if (!validFor(answer, action.actionDigest, decision.request.requestId)) {
        const outcome = this.toOutcome(
          action,
          "denied",
          undefined,
          "invalid-approval-response",
        );
        await this.record(action, "denied", "invalid-approval-response");
        return {
          decision,
          approval: answer,
          outcome,
          toolResult: {
            output: denialOutput(
              "invalid-approval-response",
              "Approval response did not match the request",
            ),
            success: false,
          },
        };
      }

      if (!answer.approved) {
        // A broker that observed expiry/abort supplies a machine-readable
        // reason; anything else is a plain user denial (spec 011 edge cases).
        // The message must match the reason — expiry is NOT an explicit user
        // denial (product acceptance feedback).
        const reason: PermissionDenyReason = typedDenyReason(answer.reason);
        const message =
          reason === "approval-expired"
            ? "The approval request expired before a decision was made."
            : reason === "approval-unavailable"
              ? "Approval is unavailable for this request."
              : "User denied tool execution.";
        const outcome = this.toOutcome(action, "denied", undefined, reason);
        await this.record(action, "denied", reason);
        return {
          decision,
          approval: answer,
          outcome,
          toolResult: {
            output: denialOutput(reason, message),
            success: false,
          },
        };
      }

      // Approved. Spec 011 (T007): validate the selection against the ORIGINAL
      // request before issuing any envelope — expiry, option membership, and
      // lifetime support. A forged/stale/expired selection fails closed and
      // never chooses another option.
      // Hard rule: Approval NEVER mutates or widens principalPolicy,
      // runtimeBaseline, or deploymentCeiling.
      if (decision.request.expiresAt < this.now()) {
        const outcome = this.toOutcome(action, "denied", undefined, "approval-expired");
        await this.record(action, "denied", "approval-expired");
        return {
          decision,
          approval: answer,
          outcome,
          toolResult: {
            output: denialOutput(
              "approval-expired",
              "Approval request expired before a decision was recorded",
            ),
            success: false,
          },
        };
      }
      const option = decision.request.approvalOptions.find(
        (o) => o.optionId === answer.optionId,
      );
      if (!option) {
        const outcome = this.toOutcome(action, "denied", undefined, "invalid-approval-response");
        await this.record(action, "denied", "invalid-approval-response");
        return {
          decision,
          approval: answer,
          outcome,
          toolResult: {
            output: denialOutput(
              "invalid-approval-response",
              "Approval named an option that is not part of the request",
            ),
            success: false,
          },
        };
      }
      const lifetimeKind = answer.lifetime ?? "action";
      if (
        !option.supportedLifetimes.includes(lifetimeKind) ||
        !decision.request.offeredLifetimes.includes(lifetimeKind)
      ) {
        const outcome = this.toOutcome(action, "denied", undefined, "invalid-approval-response");
        await this.record(action, "denied", "invalid-approval-response");
        return {
          decision,
          approval: answer,
          outcome,
          toolResult: {
            output: denialOutput(
              "invalid-approval-response",
              "Approval lifetime is not offered by the request or the selected option",
            ),
            success: false,
          },
        };
      }
      // Defense in depth (spec 011 T030): when the request carries complete
      // Domain-issued choices, the approved option/lifetime pair must be one
      // of them — a decision that cannot be expressed as a choice cannot
      // come from a compliant surface.
      if (decision.request.approvalChoices.length > 0) {
        const matchesChoice = decision.request.approvalChoices.some(
          (c) => c.optionId === option.optionId && c.lifetime === lifetimeKind,
        );
        if (!matchesChoice) {
          const outcome = this.toOutcome(action, "denied", undefined, "invalid-approval-response");
          await this.record(action, "denied", "invalid-approval-response");
          return {
            decision,
            approval: answer,
            outcome,
            toolResult: {
              output: denialOutput(
                "invalid-approval-response",
                "Approval option/lifetime pair is not a Domain-issued choice",
              ),
              success: false,
            },
          };
        }
      }
      // Resolve the typed lifetime. A session lifetime requires a bound
      // session identity and fails closed on revocation before issuance.
      let envelopeLifetime: CapabilityLifetime;
      if (lifetimeKind === "action") {
        envelopeLifetime = {
          kind: "action",
          actionDigest: action.actionDigest,
          consumeOnce: true,
        };
      } else if (lifetimeKind === "run") {
        envelopeLifetime = {
          kind: "run",
          runId: action.runId,
          expiresAt: this.now() + 86400000,
        };
      } else {
        const sessionId = action.sessionId ?? this.sessionId;
        if (!sessionId) {
          const outcome = this.toOutcome(action, "denied", undefined, "invalid-approval-response");
          await this.record(action, "denied", "invalid-approval-response");
          return {
            decision,
            approval: answer,
            outcome,
            toolResult: {
              output: denialOutput(
                "invalid-approval-response",
                "Session approval requires a bound session identity",
              ),
              success: false,
            },
          };
        }
        if (this.capabilityLedger?.isSessionRevoked(sessionId)) {
          const outcome = this.toOutcome(action, "denied", undefined, "capability-revoked");
          await this.record(action, "denied", "capability-revoked");
          return {
            decision,
            approval: answer,
            outcome,
            toolResult: {
              output: denialOutput("capability-revoked", "Session capability was revoked"),
              success: false,
            },
          };
        }
        envelopeLifetime = { kind: "session", sessionId };
      }

      approval = answer;
      const approved = option.capabilities;
      // Reevaluate ONCE with the approved capability added to a TEMPORARY
      // active-capability copy. The long-lived active set is committed only
      // for session (or shared-contract run) lifetimes below (spec 011 D8) —
      // an action approval is consumed once and never retained as session
      // authority.
      const withApproval: CapabilitySet = {
        version: 1,
        capabilities: [...this.active.capabilities, ...approved],
      };
      const reevalContext: PolicyContext = {
        ...this.policyContext,
        activeCapabilities: withApproval,
      };
      decision = this.policy.evaluate(action, reevalContext);
      if (decision.decision === "allow") {
        // The final envelope carries the SELECTED option's capabilities
        // exactly (FR-012), PLUS the action-required capabilities that were
        // already authorized before this approval (e.g. a pre-covered
        // model-egress). The envelope is the complete authority record for
        // this action; the model-egress and broker gates check it as a whole.
        const requiredCaps = decision.envelope.capabilities;
        const optionSet = { version: 1 as const, capabilities: approved };
        const alreadyAuthorized = requiredCaps.filter(
          (c) => !setCovers(optionSet, c),
        );
        decision.envelope.capabilities = [...approved, ...alreadyAuthorized];
        decision.envelope.lifetime = envelopeLifetime;
      }
      if (lifetimeKind !== "action") {
        this.active.capabilities.push(...approved);
        this.policyContext.activeCapabilities.capabilities = this.active.capabilities;
      }
    }

    // 4. Deny path — one terminal denial, no afterToolCall.
    if (decision.decision !== "allow") {
      const reason: PermissionDenyReason =
        decision.decision === "deny" ? decision.reason : "approval-unavailable";
      const message =
        decision.decision === "deny"
          ? decision.message
          : "Action was not approved";
      const outcome = this.toOutcome(action, "denied", undefined, reason);
      await this.record(action, "denied", reason);
      return {
        decision,
        approval,
        outcome,
        toolResult: {
          output: denialOutput(reason, message),
          success: false,
        },
      };
    }

    // 5. Allow path — consume action-scoped capability (T107a) + durable
    //    `dispatched` audit BEFORE execution.
    if (decision.decision === "allow") {
      const envelope = decision.envelope;
      if (this.capabilityLedger) {
        const nowTs = this.now();
        const { checkRunLifetime, checkSessionLifetime } = await import("./persisted-capability-ledger.js");

        if (envelope.lifetime.kind === "action") {
          const consumed = await this.capabilityLedger.consume(
            envelope.envelopeId,
            envelope.actionDigest,
          );
          if (!consumed) {
            // Already consumed — replay attempt.
            const outcome = this.toOutcome(
              action,
              "denied",
              undefined,
              "capability-expired",
            );
            await this.record(action, "denied", "capability-expired");
            return {
              decision,
              approval,
              outcome,
              toolResult: {
                output: denialOutput(
                  "capability-expired",
                  "Capability was already consumed (replay attempt)",
                ),
                success: false,
              },
            };
          }
        } else if (envelope.lifetime.kind === "run") {
          const runRes = checkRunLifetime(envelope.runId, envelope.expiresAt ?? Infinity, this.capabilityLedger, nowTs);
          if (runRes !== "ok") {
            const reason = runRes === "revoked" ? "capability-revoked" : "capability-expired";
            const outcome = this.toOutcome(action, "denied", undefined, reason);
            await this.record(action, "denied", reason);
            return {
              decision,
              approval,
              outcome,
              toolResult: { output: denialOutput(reason, `Run capability was ${runRes}`), success: false },
            };
          }
        } else if (envelope.lifetime.kind === "session") {
          const sessRes = checkSessionLifetime(action.sessionId ?? envelope.lifetime.sessionId, envelope.expiresAt, this.capabilityLedger, nowTs);
          if (sessRes !== "ok") {
            const reason = sessRes === "revoked" ? "capability-revoked" : "capability-expired";
            const outcome = this.toOutcome(action, "denied", undefined, reason);
            await this.record(action, "denied", reason);
            return {
              decision,
              approval,
              outcome,
              toolResult: { output: denialOutput(reason, `Session capability was ${sessRes}`), success: false },
            };
          }
        }
      }
    }

    try {
      await this.record(action, "dispatched");
    } catch {
      // Pre-dispatch audit unavailable ⇒ deny effectful dispatch.
      const outcome = this.toOutcome(
        action,
        "denied",
        undefined,
        "audit-unavailable",
      );
      await this.record(action, "denied", "audit-unavailable").catch(() => {});
      return {
        decision,
        approval,
        outcome,
        toolResult: {
          output: denialOutput(
            "audit-unavailable",
            "Pre-dispatch audit record could not be made durable",
          ),
          success: false,
        },
      };
    }

    // 6. Execute through the boundary.
    let execution: ExecutionResult;
    try {
      execution = await this.boundary.execute(action, decision.envelope, {
        signal,
        onUpdate: (chunk) => {
          runOpts?.onUpdate?.(chunk);
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      execution = {
        state: "failed",
        error: { code: "EXEC_FAILED", message, retryable: false },
        evidence: {
          backend: this.boundary.capabilities.backend,
          actionDigest: action.actionDigest,
          executorId: "unknown",
          operationKind: action.operation.kind,
        },
      };
    }

    // 7. Record terminal outcome (idempotent). A failure here is enqueued in
    //    the terminal-event outbox (FR-014): execution has already happened,
    //    so we cannot un-execute it; the outbox retries the append and the
    //    deployment reports degraded audit health until it succeeds.
    const terminalState =
      execution.state === "succeeded"
        ? "succeeded"
        : execution.state === "cancelled"
          ? "cancelled"
          : "failed";
    await this.recordTerminal(action, terminalState);

    // 8. Action-scoped capabilities are NOT removed here: since spec 011 D8
    //    they are never added to the long-lived active set in the first place
    //    (the approval path commits only session/run authority), so there is
    //    nothing to clean up. A removal pass over the envelope would wrongly
    //    strip pre-existing active authority (e.g. a baseline model-egress cap
    //    that the envelope also carries) — review fix.
    const outcome = this.toOutcome(
      action,
      terminalState,
      decision.envelope.envelopeId,
    );
    const toolResult: ToolResult =
      execution.state === "succeeded"
        ? execution.result
        : {
            output: `Tool execution failed: ${execution.error.message}`,
            success: false,
          };

    return { decision, approval, outcome, execution, toolResult };
  }

  /** Read-only view of the long-lived active capability set (test seam). */
  getActiveCapabilities(): Capability[] {
    return [...this.active.capabilities];
  }

  private toOutcome(
    action: PreparedToolAction,
    state: ToolOutcome["state"],
    envelopeId?: string,
    denial?: PermissionDenyReason,
  ): ToolOutcome {
    return {
      state,
      action,
      envelopeId,
      denial,
    };
  }

  /** Append an audit event; idempotent on `<actionId>:<state>`. */
  private async record(
    action: PreparedToolAction,
    state: import("../../foundations/contracts/execution-brokers.js").ActionState,
    reason?: PermissionDenyReason,
  ): Promise<void> {
    const event = {
      eventId: generateId(),
      actionId: action.actionId,
      actionDigest: action.actionDigest,
      principalId: action.principalId,
      runId: action.runId,
      state,
      timestamp: this.now(),
      policyDigest: this.policy.getPolicyDigest(),
      reason,
      backend: this.boundary.capabilities.backend,
    };
    await this.audit.append(event, {
      idempotencyKey: idempotencyKey(action.actionId, state),
    });
  }

  /**
   * Record a TERMINAL event with outbox fallback. If the synchronous append
   * throws, the event is enqueued in the terminal-event outbox (when wired)
   * and execution returns its result — the deployment reports degraded audit
   * health until the outbox flushes. Per FR-014, execution is never repeated
   * to compensate for a missing terminal record.
   */
  private async recordTerminal(
    action: PreparedToolAction,
    state: "succeeded" | "failed" | "cancelled",
  ): Promise<void> {
    const key = idempotencyKey(action.actionId, state);
    try {
      await this.record(action, state);
    } catch (err) {
      if (this.terminalOutbox) {
        // Build the same event record() would have appended, then enqueue.
        const event = {
          eventId: generateId(),
          actionId: action.actionId,
          actionDigest: action.actionDigest,
          principalId: action.principalId,
          runId: action.runId,
          state,
          timestamp: this.now(),
          policyDigest: this.policy.getPolicyDigest(),
          backend: this.boundary.capabilities.backend,
        };
        await this.terminalOutbox.enqueue(event, key);
      } else {
        // No outbox wired — surface the failure (default behavior pre-outbox).
        throw err;
      }
    }
  }
}

/** Type re-export for composition roots. */
export type { ToolProgress };
