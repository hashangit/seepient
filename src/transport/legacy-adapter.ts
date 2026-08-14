/**
 * Legacy-adapter helpers — Transport (spec 008 wiring).
 *
 * Adapts the existing `ApproveToolFn` callback shape (used by every current
 * adapter) into the typed `ApprovalBroker` the spec-008 pipeline expects, and
 * constructs a default execution boundary when the caller hasn't supplied one.
 *
 * These adapters exist ONLY at the transport composition roots — they are the
 * bridge from the legacy approval surface to the new pipeline. They contain no
 * policy logic.
 */
import { CallbackApprovalBroker, NoneApprovalBroker } from "./approval-brokers.js";
import type { ApprovalBroker, PermissionDecision, PermissionRequest } from "../foundations/contracts/permission-policy.js";
import type { ApproveToolFn } from "../foundations/types.js";
import type {
  ExecutionBoundary,
  ExecutionBackendCapabilities,
  ExecutionResult,
} from "../foundations/contracts/execution-boundary.js";
import type { PreparedToolAction } from "../foundations/contracts/prepared-action.js";
import type { CapabilityEnvelope } from "../foundations/contracts/permission-policy.js";
import type { ToolResult } from "../foundations/types.js";

/**
 * Wrap a legacy `ApproveToolFn` as a spec-008 `ApprovalBroker`. The legacy
 * callback returns a boolean or `{ approved, scope }` — neither carries the
 * request's `actionDigest`, so the wrapped broker supplies it from the
 * request and the lifecycle's `validFor` check still binds the decision to
 * the correct action.
 *
 * The legacy callback runs the surface's existing UX (TUI panel, readline
 * y/n, SDK custom UI, WS round-trip). No new presentation code is needed.
 */
export function legacyApproveToolToBroker(
  approveTool: ApproveToolFn | undefined,
  mode: "inline" | "callback" | "none" = approveTool ? "callback" : "none",
): ApprovalBroker {
  if (!approveTool) return new NoneApprovalBroker();
  return new CallbackApprovalBroker(async (req: PermissionRequest, opts): Promise<PermissionDecision> => {
    const scopeToLifetime = (scope?: string): "action" | "run" | "session" => {
      if (scope === "session") return "session";
      if (scope === "project" || scope === "global") return "session";
      return "action";
    };
    const decision = await approveTool({
      name: req.action.title,
      args: {
        summary: req.action.summary,
        canonicalTargets: req.action.canonicalTargets,
        effects: req.action.effects,
      },
    });
    const approved = typeof decision === "boolean" ? decision : decision.approved;
    const scope = typeof decision === "object" ? decision.scope : undefined;
    if (approved) {
      // Spec 011 (T022): a legacy approval must bind to the request's
      // narrowest policy-issued option (Domain orders narrowest first) and an
      // offered lifetime; it may not invent an option or return an
      // option-less approval. No option → approval-unavailable.
      const option = req.approvalOptions[0];
      if (!option) {
        return {
          approved: false,
          requestId: req.requestId,
          actionDigest: req.actionDigest,
          actorId: "legacy-adapter",
          reason: "approval-unavailable: request has no representable option",
          decidedAt: Date.now(),
        };
      }
      const wanted = scopeToLifetime(scope);
      const lifetime = option.supportedLifetimes.includes(wanted)
        ? wanted
        : (option.supportedLifetimes[0] ?? "action");
      return {
        approved: true,
        requestId: req.requestId,
        actionDigest: req.actionDigest,
        optionId: option.optionId,
        lifetime,
        actorId: "legacy-adapter",
        decidedAt: Date.now(),
      };
    }
    return {
      approved: false,
      requestId: req.requestId,
      actionDigest: req.actionDigest,
      actorId: "legacy-adapter",
      reason: "legacy callback denied",
      decidedAt: Date.now(),
    };
  });
}

/**
 * A boundary that delegates execution to the real tool registry. Each tool
 * call that the new pipeline approves is executed by calling `executeTool()`
 * — the SAME function the legacy path uses. The difference: the new path
 * gates the call through PolicyEngine → ApprovalBroker → audit first.
 *
 * The boundary carries the per-call arguments in a mutable slot. The
 * agent-loop sets them just before invoking the lifecycle (it has the raw
 * parsedArgs at that point; the analyzer only stores a digest).
 *
 * The boundary advertises honest capabilities: `exactCommit: false` (the
 * legacy handler writes directly, no commit broker) and
 * `environmentIsolation: false` (no sandbox). Policy therefore does not OFFER
 * capabilities that require exact-commit or sandbox enforcement.
 */
export function legacyHandlerBoundary(): ExecutionBoundary & {
  setCallContext(toolName: string, args: Record<string, unknown>, config?: Record<string, unknown>, extra?: { signal?: AbortSignal; onUpdate?: (p: { message?: string; percentage?: number }) => void }): void;
} {
  // Per-call context: set by the agent-loop just before lifecycle.run().
  let callContext: {
    toolName: string;
    args: Record<string, unknown>;
    config?: Record<string, unknown>;
    extra?: { signal?: AbortSignal; onUpdate?: (p: { message?: string; percentage?: number }) => void };
  } | undefined;

  const capabilities: ExecutionBackendCapabilities = {
    backend: "uncontained",
    capabilityKinds: ["commit-file", "read-file", "process", "model-egress"],
    exactCommit: false,
    hostFilteredEgress: false,
    environmentIsolation: false,
    supportedOperationKinds: ["none", "read-file", "commit-files", "process", "broker", "trusted-host"],
  };
  return {
    capabilities,
    setCallContext(toolName, args, config, extra) {
      callContext = { toolName, args, config, extra };
    },
    async execute(
      action: PreparedToolAction,
      envelope: CapabilityEnvelope,
    ): Promise<ExecutionResult> {
      void envelope;
      if (!callContext) {
        return {
          state: "failed",
          error: {
            code: "NO_CALL_CONTEXT",
            message: "legacyHandlerBoundary.setCallContext() was not called before execute()",
            retryable: false,
          },
          evidence: {
            backend: "uncontained",
            actionDigest: action.actionDigest,
            executorId: "legacy-handler",
            operationKind: action.operation.kind,
          },
        };
      }
      // Execute via the REAL tool registry — the same path the legacy loop uses.
      try {
        const { executeTool } = await import("../domain/tool-executor.js");
        const result = await executeTool(
          callContext.toolName,
          callContext.args,
          callContext.config,
          callContext.extra,
        );
        callContext = undefined; // clear for the next call
        return {
          state: "succeeded",
          result,
          evidence: {
            backend: "uncontained",
            actionDigest: action.actionDigest,
            executorId: "legacy-handler",
            operationKind: action.operation.kind,
          },
        };
      } catch (err) {
        callContext = undefined;
        return {
          state: "failed",
          error: {
            code: "LEGACY_HANDLER_FAILED",
            message: err instanceof Error ? err.message : String(err),
            retryable: false,
          },
          evidence: {
            backend: "uncontained",
            actionDigest: action.actionDigest,
            executorId: "legacy-handler",
            operationKind: action.operation.kind,
          },
        };
      }
    },
  };
}

export { CallbackApprovalBroker, NoneApprovalBroker };
