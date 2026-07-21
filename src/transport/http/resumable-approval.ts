/**
 * REST immediate-deny + resumable-approval contract — Transport HTTP
 * (spec 008, T406, FR-015/FR-016).
 *
 * REST NEVER waits indefinitely for a human. When policy returns
 * `needs-approval`:
 *   - `interaction: "never"`    → record a denial and let the model adapt.
 *   - `interaction: "resumable"` → persist the run checkpoint and return a
 *     typed `approval_required` response with an opaque continuation ID.
 *
 * The continuation is bound to principal, tenant, session, action digest,
 * policy digest, and expiry. Resuming reevaluates current outer ceilings
 * before dispatch — an approval never freezes a now-revoked operator policy.
 */
import type { PermissionRequest } from "../../foundations/contracts/permission-policy.js";
import type { PermissionDenyReason } from "../../foundations/contracts/permission-policy.js";

export type ChatInteraction = "never" | "resumable";

/** Response when policy returns needs-approval. */
export type ChatControlResponse =
  | { status: "completed"; result: unknown }
  | {
      status: "approval_required";
      continuationId: string;
      request: PermissionRequest;
    }
  | {
      status: "denied";
      reason: PermissionDenyReason;
      message: string;
    };

/**
 * Decide the REST response for a needs-approval decision. Pure; the actual
 * dispatch happens after the caller resumes and re-evaluates ceilings.
 */
export function handleNeedsApproval(opts: {
  interaction: ChatInteraction;
  request: PermissionRequest;
  continuationId: string;
  /** Persist the pending approval (durable store). */
  persist?: (rec: { continuationId: string; request: PermissionRequest }) => void;
}): ChatControlResponse {
  if (opts.interaction === "never") {
    return {
      status: "denied",
      reason: "approval-unavailable",
      message: "Headless REST: missing capability and approval is unavailable",
    };
  }
  // Resumable: persist + return a continuation bound to principal/action/expiry.
  opts.persist?.({ continuationId: opts.continuationId, request: opts.request });
  return {
    status: "approval_required",
    continuationId: opts.continuationId,
    request: opts.request,
  };
}

/**
 * Resume a continuation. Re-evaluates outer ceilings before dispatch: if the
 * approval no longer holds under the current operator policy, the resume is
 * denied.
 */
export function resumeContinuation(opts: {
  continuationId: string;
  decision: import("../../foundations/contracts/permission-policy.js").PermissionDecision;
  coversNow: (request: PermissionRequest) => boolean;
  lookup: (continuationId: string) => { request: PermissionRequest } | undefined;
}): { proceed: true; request: PermissionRequest } | { proceed: false; reason: PermissionDenyReason } {
  const rec = opts.lookup(opts.continuationId);
  if (!rec) return { proceed: false, reason: "approval-unavailable" };
  // Ceilings reevaluated before dispatch.
  if (!opts.coversNow(rec.request)) {
    return { proceed: false, reason: "outside-ceiling" };
  }
  if (!opts.decision.approved) return { proceed: false, reason: "user-denied" };
  // The decision must reference the same action digest.
  if (opts.decision.actionDigest !== rec.request.actionDigest) {
    return { proceed: false, reason: "invalid-approval-response" };
  }
  return { proceed: true, request: rec.request };
}
