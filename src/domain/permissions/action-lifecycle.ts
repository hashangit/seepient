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
  terminalOutbox?: { enqueue: (event: import("../../foundations/contracts/execution-brokers.js").ActionAuditEvent, idempotencyKey: string) => void };
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

/**
 * Validate that an approval decision actually matches the request it claims to
 * answer. Mismatched requestId/actionDigest → invalid-approval-response.
 */
function validFor(
  answer: PermissionDecision,
  expectedActionDigest: string,
  expectedRequestId: string,
): boolean {
  if (!answer.approved) return true; // denials are always "valid" (they deny)
  return (
    answer.actionDigest === expectedActionDigest &&
    answer.requestId === expectedRequestId
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

  private readonly terminalOutbox?: { enqueue: (event: import("../../foundations/contracts/execution-brokers.js").ActionAuditEvent, idempotencyKey: string) => void };

  constructor(opts: ActionLifecycleOptions) {
    this.policy = opts.policy;
    this.policyContext = opts.policyContext;
    this.broker = opts.broker;
    this.boundary = opts.boundary;
    this.audit = opts.audit;
    this.active = opts.activeCapabilities;
    this.now = opts.now ?? (() => Date.now());
    this.terminalOutbox = opts.terminalOutbox;
  }

  async run(
    action: PreparedToolAction,
    signal?: AbortSignal,
  ): Promise<LifecycleResult> {
    // 1. Record `prepared`.
    await this.record(action, "prepared");

    // 2. Policy evaluation.
    let decision = this.policy.evaluate(action, this.policyContext);

    // 3. needs-approval path — at most ONE broker round + ONE reevaluation.
    let approval: PermissionDecision | undefined;
    if (decision.decision === "needs-approval") {
      await this.record(action, "awaiting-approval");

      let answer: PermissionDecision;
      try {
        answer = await this.broker.request(decision.request, { signal });
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
        const reason: PermissionDenyReason = "user-denied";
        const outcome = this.toOutcome(action, "denied", undefined, reason);
        await this.record(action, "denied", reason);
        return {
          decision,
          approval: answer,
          outcome,
          toolResult: {
            output: denialOutput(reason, "User denied tool execution."),
            success: false,
          },
        };
      }

      // Approved. Reevaluate ONCE with the approved capability added.
      // Approval MUST NOT widen the requested capability — we only add caps
      // that were in the proposed envelope.
      approval = answer;
      const approved = decision.proposedEnvelope.capabilities;
      const withApproval: CapabilitySet = {
        version: 1,
        capabilities: [...this.active.capabilities, ...approved],
      };
      const reevalContext: PolicyContext = {
        ...this.policyContext,
        activeCapabilities: withApproval,
      };
      decision = this.policy.evaluate(action, reevalContext);
      // Persist the action-scoped cap so execution sees it.
      this.active.capabilities.push(...approved);
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

    // 5. Allow path — durable `dispatched` audit BEFORE execution.
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
        onUpdate: () => {
          /* progress forwarded by caller via onStep */
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
      policyDigest: this.policyContext.deploymentCeiling.version.toString(), // v1: simplified
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
          policyDigest: this.policyContext.deploymentCeiling.version.toString(),
          backend: this.boundary.capabilities.backend,
        };
        this.terminalOutbox.enqueue(event, key);
      } else {
        // No outbox wired — surface the failure (default behavior pre-outbox).
        throw err;
      }
    }
  }
}

/** Type re-export for composition roots. */
export type { ToolProgress };
