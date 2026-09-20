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

  const envKey = `NEUTRALIZE_${findingId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
  const isNeutralized =
    process.env[envKey] === "1" ||
    process.env.NEUTRALIZE_GUARD === findingId;

  return {
    findingId,
    recordHit(tag?: string) {
      if (isNeutralized) return;
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
