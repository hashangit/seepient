/**
 * Probe-matrix self-integrity (022-5-WO1 T020): the matrix enforces its own
 * wiring, and the ZERO_HITS de-confound is structural.
 *
 * (a) DOGFOOD: a registered guard with no production seam is exactly the
 * "deleted guard" scenario — assertSeamCoverage must reject it.
 * (b) CONFOUND PIN: guard.ts reads no NEUTRALIZE_* env (source pin) and the
 * counter still counts with the env vars set (behavior pin) — reverting
 * guard.ts to its old env-reading form flips the source pin red.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assertJourneyRegistration, assertSeamCoverage, extractFailSection, markerMatches } from "../probe-matrix.js";
import { createSecurityGuard } from "./guard.js";

describe("probe-matrix wiring enforcement (022-5-WO1 T020a dogfood)", () => {
  it("a registered guardId without a production seam fails the coverage lint", () => {
    expect(() =>
      assertSeamCoverage([{ guardId: "DOGFOOD-DELETED-SEAM" }], new Map([["VULN-1", ["src/x.ts"]]])),
    ).toThrow(/DOGFOOD-DELETED-SEAM.*no production isGuardNeutralized/s);
  });

  it("a production seam with no registered target fails the coverage lint (dead wiring)", () => {
    expect(() =>
      assertSeamCoverage([{ guardId: "VULN-1" }], new Map([["VULN-1", ["src/x.ts"]], ["ORPHAN-SEAM", ["src/y.ts"]]])),
    ).toThrow(/ORPHAN-SEAM.*not registered/s);
  });

  it("a guard-using journey that is neither probed nor counter-only is a registration violation", () => {
    const violations = assertJourneyRegistration(
      ["src/x/__tests__/rogue-journey.test.ts"],
      ["src/x/__tests__/probed.test.ts"],
      ["src/x/__tests__/counter-only.test.ts"],
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/rogue-journey/);
  });

  it("a wired target passes (the happy path stays green)", () => {
    expect(() =>
      assertSeamCoverage([{ guardId: "VULN-1" }], new Map([["VULN-1", ["src/capabilities/execution/effect-broker.ts"]]])),
    ).not.toThrow();
  });
});

describe("ZERO_HITS de-confound (022-5-WO1 T020b)", () => {
  it("guard.ts contains no NEUTRALIZE env read (comments may mention the rule)", () => {
    const src = readFileSync(join(process.cwd(), "src/foundations/__tests__/guard.ts"), "utf-8");
    const withoutComments = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    expect(withoutComments).not.toMatch(/NEUTRALIZE/);
  });

  it("the counter counts even with the neutralization env vars set", () => {
    const originalVuln = process.env.NEUTRALIZE_VULN_1;
    const originalGuard = process.env.NEUTRALIZE_GUARD;
    process.env.NEUTRALIZE_VULN_1 = "1";
    process.env.NEUTRALIZE_GUARD = "VULN-1";
    try {
      const guard = createSecurityGuard("VULN-1");
      guard.recordHit("still-counts");
      expect(() => guard.assertGuardedPathExecuted(1)).not.toThrow();
    } finally {
      if (originalVuln === undefined) delete process.env.NEUTRALIZE_VULN_1;
      else process.env.NEUTRALIZE_VULN_1 = originalVuln;
      if (originalGuard === undefined) delete process.env.NEUTRALIZE_GUARD;
      else process.env.NEUTRALIZE_GUARD = originalGuard;
    }
  });
});

describe("FAIL-section message matching (022-5-WO1 T021)", () => {
  it("a marker echoed only by passing-test stdout does not validate", () => {
    const output = [
      "✓ passing test mentioning CREDENTIAL_REQUIRED in its log line",
      "Failed Tests 1 failed",
      "FAIL some.test.ts > the real failure",
      "AssertionError: expected true to be false",
      "Test Files  1 failed",
    ].join("\n");
    const section = extractFailSection(output);
    expect(section).not.toContain("passing test");
    expect(markerMatches(section, "CREDENTIAL_REQUIRED")).toBe(false);
  });

  it("alternation markers match when any alternative appears in the FAIL section", () => {
    const section = extractFailSection(
      ["Failed Tests", "FAIL x > a", "EGRESS_REQUIRED: Multi-tenant inference to baseUrl", "Tests 1 failed"].join("\n"),
    );
    expect(markerMatches(section, "CREDENTIAL_REQUIRED|EGRESS_REQUIRED")).toBe(true);
    expect(markerMatches(section, "TOTALLY_ABSENT|ALSO_ABSENT")).toBe(false);
  });

  it("the FAIL section excludes the summary tail", () => {
    const section = extractFailSection(["Failed Tests", "FAIL x", "Test Files  1 failed", "Tests  1 failed", "Duration  1s"].join("\n"));
    expect(section).not.toMatch(/Test Files/);
    expect(section).not.toMatch(/Duration/);
  });
});
