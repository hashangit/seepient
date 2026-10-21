/**
 * Application Durable Store Port Contracts — Foundations (spec 029, M02 S05, FR-012/FR-014).
 *
 * The six atomic port operations between the runtime adapter and the product
 * store. Names are NORMATIVE; the storage implementation is the retained
 * product Postgres/Graphile stack (this module references NO database client —
 * ports only).
 *
 * Classification (FR-014): every operation below is **awaited-required** —
 * callers MUST await the result and branch on the failure discriminant before
 * proceeding. Observational hooks (progress notes, logging) are a SEPARATE
 * typed category (`ObservationalHooksPort`) and MUST NOT become the carrier
 * for any awaited operation.
 */

import type { AttemptId, EffectId, RunId, SessionId } from "./identity.js";

/** Classification marker for port operations. */
export type PortOperationClass = "awaited-required";

/**
 * Mechanical register: operation → classification. Exists so a reviewer (or a
 * grep gate) can assert no port operation silently degraded to observational.
 */
export const STORE_PORT_OPERATIONS = {
  appendEvent: "awaited-required",
  claimAttempt: "awaited-required",
  renewAttempt: "awaited-required",
  fenceAttempt: "awaited-required",
  claimSteering: "awaited-required",
  compareAndSetAnswer: "awaited-required",
  consumeContinuation: "awaited-required",
  reconcileExternalEffect: "awaited-required",
} as const satisfies Record<string, PortOperationClass>;

/** Unavailable storage: transient infrastructure failure; the discriminant is the retry contract. */
export interface StorageUnavailable {
  readonly kind: "unavailable";
  readonly reason?: string;
}

// ---------------------------------------------------------------------------
// Per-operation failure discriminants
// ---------------------------------------------------------------------------

/** `appendEvent`: the monotonic sequence was contended — the event was not appended. */
export interface SequenceConflict {
  readonly kind: "sequence-conflict";
  readonly expectedSequence: number;
  readonly actualSequence: number;
}

/** Attempt/lease CAS lost at the dispatch boundary — another claimant owns the attempt. */
export interface LeaseLost {
  readonly kind: "lease-lost";
  readonly currentFence: number;
}

/** `claimSteering`: another claimant won this message; the loser must not re-claim. */
export interface SteeringClaimed {
  readonly kind: "steering-claimed";
  readonly claimedBy: string;
}

/** `compareAndSetAnswer`: a winner already exists — this caller is a loser, deterministically. */
export interface AnswerAlreadySet {
  readonly kind: "answer-already-set";
  readonly winnerPrincipalId: string;
}

/** `consumeContinuation`: exactly-once resume already consumed (or never existed). */
export interface ContinuationNotConsumable {
  readonly kind: "continuation-not-consumable";
  readonly state: "already-consumed" | "not-found";
}

/**
 * `reconcileExternalEffect`: the external side effect's outcome is genuinely
 * ambiguous (e.g. timeout after unknown remote completion). The reconcile
 * records the ambiguity rather than inventing an outcome.
 */
export interface EffectAmbiguityRecorded {
  readonly kind: "effect-ambiguity-recorded";
  readonly effectId: EffectId;
  readonly detail?: string;
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/** Event durability: monotonic sequence, exactly-once per event. */
export interface EventStorePort {
  /**
   * Append one run event at its sequence. Atomicity: monotonic per-thread
   * sequence, exactly-once per event — a conflicting sequence appends nothing.
   */
  appendEvent(
    event: {
      readonly sessionId: SessionId;
      readonly runId: RunId;
      readonly sequence: number;
      readonly payload: unknown;
    },
  ): Promise<{ ok: true; sequence: number } | { ok: false; failure: SequenceConflict | StorageUnavailable }>;
}

/** Run lease: compare-and-set at the dispatch boundary. */
export interface RunLeasePort {
  /** Claim an attempt for execution. Atomicity: CAS — exactly one claimant per attempt generation. */
  claimAttempt(attempt: {
    readonly runId: RunId;
    readonly attemptId: AttemptId;
    readonly claimant: string;
  }): Promise<{ ok: true; fence: number } | { ok: false; failure: LeaseLost | StorageUnavailable }>;

  /** Extend a held lease. Atomicity: CAS against the caller's current fence. */
  renewAttempt(attempt: {
    readonly runId: RunId;
    readonly attemptId: AttemptId;
    readonly claimant: string;
    readonly fence: number;
  }): Promise<{ ok: true; fence: number } | { ok: false; failure: LeaseLost | StorageUnavailable }>;

  /** Verify a lease without extending it (settlement-time fencing). Atomicity: read-with-fence-check. */
  fenceAttempt(attempt: {
    readonly runId: RunId;
    readonly attemptId: AttemptId;
    readonly claimant: string;
    readonly fence: number;
  }): Promise<{ ok: true } | { ok: false; failure: LeaseLost | StorageUnavailable }>;
}

/** Durable steering: exactly-once claim per message at a safe turn boundary. */
export interface SteeringPort {
  /**
   * Claim unseen steering messages. Atomicity: exactly-once claim per message
   * — messages in `seenIds` are never returned again, to anyone.
   */
  claimSteering(
    request: { readonly sessionId: SessionId; readonly seenIds: string[] },
  ): Promise<
    | { ok: true; messages: ReadonlyArray<{ id: string; messageId: string; text: string }> }
    | { ok: false; failure: SteeringClaimed | StorageUnavailable }
  >;
}

/** Answers: single winner per request. */
export interface AnswerPort {
  /**
   * Record an answer (permission decision or user input) — compare-and-set on
   * the request record. Atomicity: exactly one winner per requestId; losers
   * get `answer-already-set`, never a partial write.
   */
  compareAndSetAnswer(
    answer: {
      readonly requestId: string;
      readonly principalId: string;
      readonly digestOrVersion: string;
      readonly decision: unknown;
    },
  ): Promise<{ ok: true } | { ok: false; failure: AnswerAlreadySet | StorageUnavailable }>;
}

/** Continuations: exactly-once resume. */
export interface ContinuationPort {
  /**
   * Consume a pending continuation token. Atomicity: exactly-once — the second
   * consumer observes `already-consumed`, never a double resume.
   */
  consumeContinuation(
    token: { readonly runId: RunId; readonly continuationId: string },
  ): Promise<
    | { ok: true; continuation: { readonly payload: unknown } }
    | { ok: false; failure: ContinuationNotConsumable | StorageUnavailable }
  >;
}

/** External effects: idempotent reconcile with an ambiguity record. */
export interface ExternalEffectPort {
  /**
   * Reconcile an externally submitted effect against its recorded intent.
   * Atomicity: idempotent — replaying the same reconcile is a no-op. Genuine
   * outcome ambiguity is RECORDED (`effect-ambiguity-recorded`), never guessed.
   */
  reconcileExternalEffect(
    effect: {
      readonly effectId: EffectId;
      readonly observedOutcome: "completed" | "failed" | "unknown";
      readonly detail?: string;
    },
  ): Promise<{ ok: true } | { ok: false; failure: EffectAmbiguityRecorded | StorageUnavailable }>;
}

/**
 * The composed port surface the adapter consumes. Interfaces only — the
 * retained Postgres/Graphile implementation satisfies these during scope 1.
 */
export interface AppStorePorts {
  readonly events: EventStorePort;
  readonly leases: RunLeasePort;
  readonly steering: SteeringPort;
  readonly answers: AnswerPort;
  readonly continuations: ContinuationPort;
  readonly externalEffects: ExternalEffectPort;
}

// ---------------------------------------------------------------------------
// Observational hooks — separate category, NEVER an awaited-operation carrier
// ---------------------------------------------------------------------------

/** Fire-and-forget progress note. No result, no state transition, no atomicity. */
export interface ProgressNote {
  readonly runId: RunId;
  readonly text: string;
}

export interface ObservationalHooksPort {
  onProgress?(note: ProgressNote): void;
}

/**
 * Compile-time guard of the FR-014 separation: the observational port is NOT
 * assignable to `AppStorePorts` (its methods return void, port operations
 * return awaited results) — a hook cannot stand in for a port.
 */
export type ObservationalPortIsNotAStorePort = ObservationalHooksPort extends AppStorePorts ? never : true;
