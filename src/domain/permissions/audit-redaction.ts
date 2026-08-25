/**
 * Audit redaction helpers for capabilities.
 */

import type { Capability } from "../../foundations/contracts/permission-policy.js";

/**
 * Audit-copy of a capability: process argv is REDACTED (SC-011: the audit
 * never stores raw sensitive command arguments). The capability's kind,
 * executable, and shape remain for forensics; enforcement uses the exact
 * capabilities, never this copy.
 */
export function redactAuditCapability(cap: Capability): Capability {
  if (cap.kind === "process") {
    return { ...cap, argvPrefix: undefined };
  }
  return cap;
}
