/**
 * Server policy intersection — Domain (spec 008, T401, FR-004/FR-017).
 *
 * Effective server authority is a monotonic intersection:
 *
 *   operator deployment ceiling
 *     ∩ authenticated principal/API-key policy
 *     ∩ tenant/session workspace policy
 *     ∩ request restriction
 *     ∩ approved action capability
 *     ∩ worker backend support
 *
 * Client input can narrow only. Unknown or missing principal policy fails
 * closed. Omitting request grants does NOT automatically give the caller the
 * whole ceiling — the principal baseline defines default authority.
 */
import type {
  Capability,
  CapabilitySet,
} from "../../foundations/contracts/permission-policy.js";
import type { PermissionRequest, PermissionDecision } from "../../foundations/contracts/permission-policy.js";
import { intersect } from "./capability-store.js";

/** Server-side policy context (additive over the local PolicyContext). */
export interface ServerPolicyContext {
  principalId: string;
  tenantId: string;
  sessionId: string;
  deploymentCeiling: CapabilitySet;
  principalPolicy: CapabilitySet;
  workspacePolicy: CapabilitySet;
  requestRestriction?: CapabilitySet;
  approvalMode: "never" | "remote";
}

/** Empty set constant (re-used for missing request restriction). */
const EMPTY: CapabilitySet = { version: 1, capabilities: [] };

/**
 * Compute the effective server capability set BEFORE per-action approval.
 * Used to populate `PolicyContext` for the engine.
 */
export function serverEffectiveCapabilities(ctx: ServerPolicyContext): {
  capabilities: CapabilitySet;
  failed: boolean;
  failureReason?: "missing-principal-policy" | "outside-ceiling";
} {
  // Unknown/missing principal policy → fail closed.
  if (ctx.principalPolicy.capabilities.length === 0 && !ctxHasPrincipal(ctx)) {
    return {
      capabilities: EMPTY,
      failed: true,
      failureReason: "missing-principal-policy",
    };
  }

  const request = ctx.requestRestriction ?? { version: 1 as const, capabilities: [] };
  // Request restriction may only narrow; if it references capabilities
  // outside principal, those are dropped by intersection. Omitting request
  // restriction entirely uses the principal baseline (NOT the whole ceiling).
  const baseline = ctx.requestRestriction
    ? intersect(ctx.principalPolicy, request)
    : ctx.principalPolicy;

  const effective = intersect(
    intersect(ctx.deploymentCeiling, ctx.workspacePolicy),
    baseline,
  );

  return { capabilities: effective, failed: false };
}

/** Heuristic: does the context declare a principal (even with empty policy)? */
function ctxHasPrincipal(ctx: ServerPolicyContext): boolean {
  return ctx.principalId !== "" && ctx.principalId !== "anonymous";
}

/**
 * Does the effective set cover a requested capability? Re-exported from
 * capability-store for server handlers that reason about individual caps.
 */
export function serverCapabilityCovers(
  effective: CapabilitySet,
  requested: Capability,
): boolean {
  return effective.capabilities.some((c) => coversEqual(c, requested));
}

/** Structural equality for the server's narrower coverage check. */
function coversEqual(a: Capability, b: Capability): boolean {
  if (a.kind !== b.kind) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

export { intersect };
export interface PendingApprovalRecord {
  continuationId: string;
  tenantId: string;
  sessionId: string;
  request: PermissionRequest;
  version: number;
  status: "pending" | "approved" | "denied" | "cancelled" | "expired";
  decision?: PermissionDecision;
}

export class PendingApprovalStore {
  private records = new Map<string, PendingApprovalRecord>();

  create(input: {
    request: PermissionRequest;
    tenantId: string;
    sessionId: string;
    continuationId: string;
  }): PendingApprovalRecord {
    const existing = [...this.records.values()].find((r) => r.request.requestId === input.request.requestId);
    if (existing) return existing;

    const rec: PendingApprovalRecord = {
      continuationId: input.continuationId,
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      request: input.request,
      version: 1,
      status: "pending",
    };
    this.records.set(input.continuationId, rec);
    return rec;
  }

  cas(
    continuationId: string,
    expectedVersion: number,
    decision: PermissionDecision,
  ): { status: "transitioned" | "duplicate" | "stale" | "expired"; record?: PendingApprovalRecord } {
    const rec = this.records.get(continuationId);
    if (!rec) return { status: "stale" };
    if (rec.version !== expectedVersion) return { status: "stale" };
    if (rec.status !== "pending") return { status: "duplicate" };
    if (rec.request.expiresAt <= Date.now()) {
      rec.status = "expired";
      return { status: "expired", record: rec };
    }
    rec.status = decision.approved ? "approved" : "denied";
    rec.decision = decision;
    rec.version += 1;
    return { status: "transitioned", record: rec };
  }

  listPending(opts: { principalId?: string; tenantId?: string; sessionId?: string }): PendingApprovalRecord[] {
    const now = Date.now();
    return [...this.records.values()].filter((r) => {
      if (r.status !== "pending") return false;
      if (r.request.expiresAt <= now) return false;
      if (opts.principalId && r.request.principalId !== opts.principalId) return false;
      if (opts.tenantId && r.tenantId !== opts.tenantId) return false;
      if (opts.sessionId && r.sessionId !== opts.sessionId) return false;
      return true;
    });
  }

  cancel(continuationId: string): void {
    const rec = this.records.get(continuationId);
    if (rec && rec.status === "pending") {
      rec.status = "cancelled";
    }
  }

  reevaluate(continuationId: string, allowed: boolean): void {
    const rec = this.records.get(continuationId);
    if (rec && rec.status === "approved" && !allowed) {
      rec.status = "denied";
    }
  }
}
