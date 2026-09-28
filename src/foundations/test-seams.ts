/**
 * Test-only neutralization seams for the mutation-probe matrix (SC-004, FR-018).
 *
 * Each call site wraps ONE production guard; scripts/verify-mutation-probes.ts
 * sets the matching env var and proves the corresponding security journey
 * turns red without that guard. Seams are inert unless NODE_ENV === "test",
 * so no hosted or embedded deployment can ever disable a guard through them.
 */
export function isGuardNeutralized(findingId: string): boolean {
  // Two-factor activation (022-5 FR-008, RA-1): the NODE_ENV value alone is
  // not enough — staging/preview processes commonly run with NODE_ENV=test,
  // and env vars there must never disable a guard. Neutralization requires
  // BOTH the test env AND a vitest worker (the only setter is the probe
  // harness spawning `vitest run`).
  if (process.env.NODE_ENV !== "test" || process.env.VITEST !== "true") return false;
  const envKey = `NEUTRALIZE_${findingId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
  return process.env[envKey] === "1" || process.env.NEUTRALIZE_GUARD === findingId;
}

/**
 * Hosted surfaces call this at boot: running a server or worker with
 * NODE_ENV=test is a misconfiguration worth shouting about (guards'
 * blast radius narrows and probe env vars would be one factor away).
 */
export function warnIfTestEnvAtHostedBoot(surface: string): void {
  if (process.env.NODE_ENV === "test") {
    console.error(
      `[seepient] WARNING: ${surface} is running with NODE_ENV=test. ` +
        `This is a test-only value; hosted surfaces must run with a production NODE_ENV.`,
    );
  }
}
