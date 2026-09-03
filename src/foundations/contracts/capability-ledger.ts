/**
 * Capability ledger contract — Foundations (spec 021, FR-004).
 *
 * Defines the storage contract for capability consumption and revocation
 * tracking. Tracks consumed action-scoped envelopes and revoked run/session
 * grants.
 *
 * Consumed by PolicyEngine and ActionLifecycle. Implemented by
 * PersistedCapabilityLedger and embedder-supplied ledger backends.
 */

/** Revocation filter — what to revoke. */
export interface RevokeFilter {
  runId?: string;
  sessionId?: string;
}

/**
 * Capability ledger interface.
 *
 * Embedder implementations must ensure atomic consumption against the
 * policy digest it authenticates.
 */
export interface CapabilityLedger {
  /** Load existing ledger state from persistent storage if applicable. */
  load(): Promise<void>;

  /**
   * Atomically consume an action-scoped envelope. If the actionDigest has
   * already been consumed, returns false (replay -> capability-expired).
   * Otherwise records the consumption durably and returns true.
   */
  consume(envelopeId: string, actionDigest: string): Promise<boolean>;

  /**
   * Revoke a run-scoped or session-scoped grant. Subsequent isConsumed/isRevoked
   * checks for that runId/sessionId return true (fail closed with capability-revoked).
   */
  revoke(filter: RevokeFilter): Promise<void>;

  /** True if the actionDigest was already consumed. */
  isConsumedDigest(actionDigest: string): boolean;

  /** True if the run was revoked. */
  isRunRevoked(runId: string): boolean;

  /** True if the session was revoked. */
  isSessionRevoked(sessionId: string): boolean;
}
