export interface SecurityGuard {
  readonly findingId: string;
  recordHit(tag?: string): void;
  hits(): number;
  assertGuardedPathExecuted(minHits?: number): void;
}

/**
 * Creates an anti-vacuity guard for a security test (FR-003).
 * Ensures that the test actually exercises the intended guarded code path.
 */
export function createSecurityGuard(findingId: string): SecurityGuard {
  let count = 0;
  const tags: string[] = [];

  // 022-5 FR-008 (de-confound): this counter ALWAYS counts. It must never
  // read NEUTRALIZE_* env — under mutation-probe neutralization the RED must
  // come from the journey's security assertion failing because the production
  // guard is disabled, never from a ZERO_HITS throw here. (The old env read
  // made 8/11 probe targets flip red from the counter alone, so the matrix
  // could not detect an orphaned production seam.)
  return {
    findingId,
    recordHit(tag?: string) {
      count++;
      if (tag) tags.push(tag);
    },
    hits() {
      return count;
    },
    assertGuardedPathExecuted(minHits = 1) {
      if (count < minHits) {
        throw new Error(
          `ZERO_HITS: Security test for ${findingId} recorded ${count} hits (expected >= ${minHits}) on guarded path; test is vacuous`,
        );
      }
    },
  };
}
