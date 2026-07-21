/**
 * Durable pending-approval store — Domain (spec 008, T407/T408, FR-016).
 *
 * Pending approvals are stored durably rather than as socket-owned Promises.
 * States: pending | approved | denied | expired | cancelled. Compare-and-set
 * permits exactly one terminal response. Reconnecting clients can list/recover
 * pending requests. Instance restart or horizontal routing does not lose state.
 * Expiry and cancellation deny safely. Late/duplicate responses are idempotently
 * rejected. Ceilings are reevaluated before execution.
 *
 * This is an in-memory reference implementation suitable for single-instance
 * deployments and tests. The contract (PendingApprovalStore) is what server
 * deployments implement over PostgreSQL/Redis with transactional CAS.
 */
import type { PermissionRequest } from "../../foundations/contracts/permission-policy.js";
import type { PermissionDecision } from "../../foundations/contracts/permission-policy.js";

export type PendingApprovalState =
  | "pending"
  | "approved"
  | "denied"
  | "expired"
  | "cancelled";

export interface PendingApprovalRecord {
  request: PermissionRequest;
  tenantId: string;
  sessionId: string;
  state: PendingApprovalState;
  version: number;
  continuationId: string;
  /** The decision, once terminal. */
  decision?: PermissionDecision;
  createdAt: number;
  updatedAt: number;
}

/**
 * Compare-and-set pending-approval store. Single-instance reference impl.
 * Production deployments substitute a transactional SQL/Redis backing store
 * that implements the same contract.
 */
export class PendingApprovalStore {
  private readonly records = new Map<string, PendingApprovalRecord>();
  private readonly byPrincipal = new Map<string, Set<string>>();

  /**
   * Create a pending approval. Idempotent on requestId — a replay of the same
   * request returns the existing record (no duplicate).
   */
  create(rec: Omit<PendingApprovalRecord, "version" | "createdAt" | "updatedAt" | "state">): PendingApprovalRecord {
    const existing = this.findByRequestId(rec.request.requestId);
    if (existing) return existing;
    const now = Date.now();
    const full: PendingApprovalRecord = {
      ...rec,
      state: "pending",
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(full.continuationId, full);
    this.indexPrincipal(full.request.principalId, full.continuationId);
    return full;
  }

  /** Read by continuation ID. */
  get(continuationId: string): PendingApprovalRecord | undefined {
    return this.records.get(continuationId);
  }

  /** Find by request ID (idempotency lookup). */
  findByRequestId(requestId: string): PendingApprovalRecord | undefined {
    for (const rec of this.records.values()) {
      if (rec.request.requestId === requestId) return rec;
    }
    return undefined;
  }

  /** All pending records for a principal/session (recovery on reconnect). */
  listPending(principalId: string, sessionId?: string): PendingApprovalRecord[] {
    const ids = this.byPrincipal.get(principalId) ?? new Set();
    return Array.from(ids)
      .map((id) => this.records.get(id))
      .filter(
        (r): r is PendingApprovalRecord =>
          !!r &&
          r.state === "pending" &&
          (sessionId === undefined || r.sessionId === sessionId),
      );
  }

  /**
   * Compare-and-set a terminal decision. Only a `pending` record can transition
   * to approved/denied/cancelled. Late/duplicate responses are rejected
   * idempotently (return `"duplicate"`).
   */
  cas(
    continuationId: string,
    expectedVersion: number,
    decision: PermissionDecision,
    now: number = Date.now(),
  ): { status: "transitioned" | "duplicate" | "stale" | "not-found" | "expired" } {
    const rec = this.records.get(continuationId);
    if (!rec) return { status: "not-found" };
    // Expiry check — an expired record denies safely.
    if (rec.request.expiresAt <= now) {
      if (rec.state === "pending") {
        rec.state = "expired";
        rec.version += 1;
        rec.updatedAt = now;
      }
      return { status: "expired" };
    }
    if (rec.state !== "pending") return { status: "duplicate" };
    if (rec.version !== expectedVersion) return { status: "stale" };

    rec.state = decision.approved ? "approved" : "denied";
    rec.decision = decision;
    rec.version += 1;
    rec.updatedAt = now;
    return { status: "transitioned" };
  }

  /** Cancel a pending approval (e.g. abort signal, parent request cancelled). */
  cancel(continuationId: string, now: number = Date.now()): void {
    const rec = this.records.get(continuationId);
    if (rec && rec.state === "pending") {
      rec.state = "cancelled";
      rec.version += 1;
      rec.updatedAt = now;
    }
  }

  /**
   * Reevaluate outer ceilings before dispatch. If a now-revoked operator policy
   * no longer covers the requested capability, flip an approved record back to
   * denied (the approval never freezes a now-revoked ceiling).
   */
  reevaluate(
    continuationId: string,
    covers: (request: PermissionRequest) => boolean,
    now: number = Date.now(),
  ): void {
    const rec = this.records.get(continuationId);
    if (!rec || rec.state !== "approved") return;
    if (!covers(rec.request)) {
      rec.state = "denied";
      rec.version += 1;
      rec.updatedAt = now;
    }
  }

  private indexPrincipal(principalId: string, continuationId: string): void {
    let set = this.byPrincipal.get(principalId);
    if (!set) {
      set = new Set();
      this.byPrincipal.set(principalId, set);
    }
    set.add(continuationId);
  }
}
