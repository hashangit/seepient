import { describe, it, expect } from "vitest";
import { createSecurityGuard } from "./_guard.js";

describe("FR-003 anti-vacuity harness", () => {
  it("throws ZERO_HITS when guarded path is not executed", () => {
    const guard = createSecurityGuard("VULN-TEST");
    expect(() => guard.assertGuardedPathExecuted(1)).toThrow(/ZERO_HITS/);
  });

  it("passes when guarded path records required hits", () => {
    const guard = createSecurityGuard("VULN-TEST");
    guard.recordHit("action");
    expect(() => guard.assertGuardedPathExecuted(1)).not.toThrow();
  });
});
