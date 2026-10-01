/**
 * Probe-matrix wiring primitives (022-5-WO1 T018-T021).
 *
 * Single source of truth for the lint and evidence rules: scripts/verify-mutation-probes.ts
 * executes them; src/foundations/__tests__/probe-self-integrity.test.ts pins
 * them. Pure where possible — the fs/grep side lives behind injectable
 * parameters so tests can drive violations without touching the tree.
 */

/** The failing-tests section of vitest output ("Failed Tests"/"FAIL" lines
 *  through the summary). Passing tests' stdout never enters it. */
export function extractFailSection(output: string): string {
  const stripped = output.replace(/\x1b\[[0-9;]*m/g, "");
  const keep: string[] = [];
  let inFailSection = false;
  for (const line of stripped.split("\n")) {
    if (/^\s*(Failed Tests|Unhandled Errors?)\b/.test(line) || /^\s*FAIL\s+/.test(line)) {
      inFailSection = true;
    }
    if (/^\s*(Test Files\s+\d+|Tests\s+\d+|Duration\s)/.test(line)) {
      inFailSection = false;
    }
    if (inFailSection) keep.push(line);
  }
  return keep.join("\n");
}

/** Verbatim match, or (alternation form "A|B") any single alternative. */
export function markerMatches(failSection: string, expectedMessage: string): boolean {
  if (failSection.includes(expectedMessage)) return true;
  if (expectedMessage.includes("|")) {
    return expectedMessage.split("|").some((alt) => failSection.includes(alt));
  }
  return false;
}

/** Lint 1+2 (T018): every registered guardId has >= 1 production call site;
 *  every production seam id is registered. */
export function assertSeamCoverage(
  targets: { guardId: string }[],
  seams: Map<string, string[]>,
): void {
  const violations: string[] = [];
  for (const t of targets) {
    if (!seams.has(t.guardId)) {
      violations.push(`guard "${t.guardId}" has no production isGuardNeutralized("${t.guardId}") call site — its probe would be vacuous`);
    }
  }
  const registered = new Set(targets.map((t) => t.guardId));
  for (const id of seams.keys()) {
    if (!registered.has(id)) {
      violations.push(`production seam "${id}" is not registered in PROBE_TARGETS — dead seam wiring`);
    }
  }
  if (violations.length > 0) {
    throw new Error(`SEAM COVERAGE violations:\n  - ${violations.join("\n  - ")}`);
  }
}

/** Lint 3 (T019): every guard-using journey is probed or explicitly
 *  counter-only; every counter-only entry exists on disk. */
export function assertJourneyRegistration(
  guardUsingJourneys: readonly string[],
  probeFiles: readonly string[],
  counterFiles: readonly string[],
): string[] {
  const probeSet = new Set(probeFiles);
  const counterSet = new Set(counterFiles);
  const violations: string[] = [];
  for (const file of guardUsingJourneys) {
    if (!probeSet.has(file) && !counterSet.has(file)) {
      violations.push(`security journey ${file} uses createSecurityGuard but is neither a PROBE_TARGET nor COUNTER_ONLY_JOURNEYS entry`);
    }
  }
  return violations;
}
