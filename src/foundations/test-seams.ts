/**
 * Test-only neutralization seams for the mutation-probe matrix (SC-004, FR-018).
 *
 * Each call site wraps ONE production guard; scripts/verify-mutation-probes.ts
 * sets the matching env var and proves the corresponding security journey
 * turns red without that guard. Seams are inert unless NODE_ENV === "test",
 * so no hosted or embedded deployment can ever disable a guard through them.
 */
export function isGuardNeutralized(findingId: string): boolean {
  if (process.env.NODE_ENV !== "test") return false;
  const envKey = `NEUTRALIZE_${findingId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
  return process.env[envKey] === "1" || process.env.NEUTRALIZE_GUARD === findingId;
}
