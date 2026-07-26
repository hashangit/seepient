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
    // Bridge back to the legacy signature.
    const decision = await approveTool({
      name: req.action.title,
      args: {}, // the legacy callback doesn't need args; it has its own UX context
    });
    const approved = typeof decision === "boolean" ? decision : decision.approved;
    if (approved) {
      return {
        approved: true,
        requestId: req.requestId,
        actionDigest: req.actionDigest,
        lifetime: "action",
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
 * A boundary that delegates execution to the LEGACY tool handler — i.e. it
 * runs the existing `executeTool()` path BUT through the new pipeline's
 * policy/approval/audit gates. This is the bridge for tools that haven't
 * been migrated to a native executor (commit-files, process, broker).
 *
 * Why this exists: the spec ships behind a flag precisely so that tools can
 * be migrated one-by-one to native executors. Until a tool has a native
 * executor, the legacy handler runs — but policy and audit still govern it.
 * When a native executor IS registered, it takes precedence.
 *
 * The boundary advertises honest capabilities: `exactCommit: false` (the
 * legacy handler writes directly, no commit broker) and
 * `environmentIsolation: false` (no sandbox). Policy therefore does not OFFER
 * capabilities that require exact-commit or sandbox enforcement.
 */
export function legacyHandlerBoundary(): ExecutionBoundary & {
  setHandler(handler: (action: PreparedToolAction) => Promise<ToolResult>): void;
} {
  let handler: ((action: PreparedToolAction) => Promise<ToolResult>) | undefined;
  const capabilities: ExecutionBackendCapabilities = {
    backend: "uncontained",
    // Legacy handlers can read/write files and run processes, but NOT through
    // an enforceable boundary — so we advertise only the kinds that policy
    // treats as "the legacy handler does this without enforcement." Policy
    // still gates the call; it just can't promise exact-commit or sandbox.
    capabilityKinds: ["commit-file", "read-file", "process", "model-egress"],
    exactCommit: false,
    hostFilteredEgress: false,
    environmentIsolation: false,
    supportedOperationKinds: ["none", "read-file", "commit-files", "process", "broker", "trusted-host"],
  };
  return {
    capabilities,
    setHandler(fn) {
      handler = fn;
    },
    async execute(
      action: PreparedToolAction,
      envelope: CapabilityEnvelope,
    ): Promise<ExecutionResult> {
      void envelope;
      if (!handler) {
        return {
          state: "failed",
          error: {
            code: "NO_LEGACY_HANDLER",
            message: "legacyHandlerBoundary has no handler set",
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
      try {
        const result = await handler(action);
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
