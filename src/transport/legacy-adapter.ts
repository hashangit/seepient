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

export { CallbackApprovalBroker, NoneApprovalBroker };
