/**
 * Spec 027 (T016, FR-008): security gates on both sides of the split.
 *
 * The engine-coupled security plane (tenancy stamping, inference egress
 * arming, permission/consent lifecycle) SHIPS IN seepient-core — the
 * workspace `seepient-core` specifier must resolve into packages/core, and
 * an engine-coupled journey must behave identically when driven through the
 * package path. The executor-bound suites (read-plane identity binding,
 * sandbox) keep running against the FULL package in their own files — this
 * split is enforced by the tracer (core emit excludes executors) and B-3.
 */
import { describe, it, expect } from "vitest";

describe("027 security gates across the split (T016)", () => {
  it("the seepient-core workspace specifier resolves into packages/core", () => {
    const resolved = import.meta.resolve("seepient-core/dist/transport/sdk/core.js");
    expect(resolved.replace(/\\/g, "/")).toContain("packages/core/dist/transport/sdk/core.js");
  });

  it("an engine-coupled journey (tenancy upgrade) behaves identically through the package path", async () => {
    const { resolveTenancyMode } = await import(
      "seepient-core/dist/domain/tenancy/tenancy-mode.js"
    );
    const upgraded = resolveTenancyMode({
      explicit: undefined,
      principalIdSet: true,
      anyStoreInjected: true,
      runtimeInjected: false,
      persistInjected: false,
      skillSourcesInjected: false,
      credentialsInjected: false,
    });
    expect(upgraded.mode).toBe("multi");
    expect(upgraded.upgraded).toBe(true);
    const single = resolveTenancyMode({
      explicit: "single",
      principalIdSet: false,
      anyStoreInjected: false,
      runtimeInjected: false,
      persistInjected: false,
      skillSourcesInjected: false,
      credentialsInjected: false,
    });
    expect(single.mode).toBe("single");
    expect(single.upgraded).toBe(false);
  });

  // The security-suite INVENTORY count (QS-4: vitest list | grep -icE
  // 'tenancy|egress|ssrf|vuln|permission|consent') is asserted by the QS-4
  // gate command, not in-suite — a nested vitest subprocess under a running
  // suite is slow and contention-flaky. Baseline recorded 2026-10-07: 711
  // matched test names; the count may only grow.
});
