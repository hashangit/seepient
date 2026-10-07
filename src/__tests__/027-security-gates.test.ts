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
import { execSync } from "node:child_process";

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

  it("the security-suite inventory stays at or above its recorded baseline (QS-4)", () => {
    // Baseline recorded at implementation time (027 T016); adjust only when
    // suites are ADDED, never downward.
    const list = execSync(
      `pnpm exec vitest list 2>/dev/null | grep -icE 'tenancy|egress|ssrf|vuln|permission|consent' || true`,
      { cwd: new URL("../..", import.meta.url).pathname, encoding: "utf8", shell: "/bin/bash" },
    );
    const count = parseInt(list.trim(), 10);
    expect(count).toBeGreaterThanOrEqual(20);
    console.log(`[027] security-suite inventory baseline: ${count} matched test names`);
  });
});
