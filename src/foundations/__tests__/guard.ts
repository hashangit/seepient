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
