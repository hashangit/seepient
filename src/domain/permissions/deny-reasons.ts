/**
 * Known permission deny reasons and mapping helper.
 */

import type { PermissionDenyReason } from "../../foundations/contracts/permission-policy.js";

/** Keep in sync with `PermissionDenyReason` in permission-policy.ts. */
export const KNOWN_DENY_REASONS = new Set<string>([
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
export function typedDenyReason(reason: string | undefined): PermissionDenyReason {
  return reason !== undefined && KNOWN_DENY_REASONS.has(reason)
    ? (reason as PermissionDenyReason)
    : "user-denied";
}
