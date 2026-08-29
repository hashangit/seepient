/**
 * P6 capability matrix tests (spec 008, T602, FR-003/FR-011).
 *
 * Verifies: every row reports honest enforcement; browser-worker is
 * unsupported; Windows fails closed for exact-commit + process; lookup
 * resolves the current platform; the matrix is non-empty and well-formed.
 */
import { describe, it, expect } from "vitest";
import {
  CAPABILITY_MATRIX,
  lookupPlatformCapability,
  renderCapabilityMatrix,
} from "../capability-matrix.js";

describe("capability matrix (T602)", () => {
  it("every row declares all guarantee fields", () => {
    for (const row of CAPABILITY_MATRIX) {
      expect(row.guarantees).toHaveProperty("exactCommit");
      expect(row.guarantees).toHaveProperty("hostFilteredEgress");
      expect(row.guarantees).toHaveProperty("environmentIsolation");
      expect(row.guarantees).toHaveProperty("processContainment");
      expect(row.guarantees).toHaveProperty("tenantIsolation");
    }
  });

  it("browser-worker is unsupported (no operation kinds)", () => {
    const browser = CAPABILITY_MATRIX.filter((r) => r.backend === "browser-worker");
    expect(browser.length).toBeGreaterThan(0);
    for (const row of browser) {
      expect(row.supportedOperationKinds).toEqual([]);
      expect(row.failClosed).toBe(true);
    }
  });

  it("Windows fails closed for exact-commit and process-containment", () => {
    const windows = CAPABILITY_MATRIX.find((r) => r.platform === "windows");
    expect(windows).toBeDefined();
    if (windows) {
      expect(windows.guarantees.exactCommit).toBe(false);
      expect(windows.guarantees.processContainment).toBe(false);
      expect(windows.failClosed).toBe(true);
    }
  });

  it("docker-worker offers tenant isolation (per-run ephemeral container)", () => {
    const docker = CAPABILITY_MATRIX.find((r) => r.backend === "docker-worker");
    expect(docker?.guarantees.tenantIsolation).toBe(true);
  });

  it("uncontained never claims process containment", () => {
    const unc = CAPABILITY_MATRIX.find((r) => r.backend === "uncontained");
    expect(unc?.guarantees.processContainment).toBe(false);
    expect(unc?.guarantees.environmentIsolation).toBe(false);
    expect(unc?.failClosed).toBe(false); // operator opt-in
  });

  it("lookupPlatformCapability resolves the current platform", () => {
    const row = lookupPlatformCapability("local-native", process.platform);
    expect(row).toBeDefined();
    expect(row?.backend).toBe("local-native");
  });

  it("renderCapabilityMatrix produces readable output", () => {
    const text = renderCapabilityMatrix();
    expect(text).toContain("local-native");
    expect(text).toContain("docker-worker");
    expect(text).toContain("browser-worker");
    expect(text).toContain("exact:");
    expect(text).toContain("fail-closed");
  });

  it("macOS and Linux both offer exact-commit + filtered egress", () => {
    const mac = CAPABILITY_MATRIX.find((r) => r.backend === "local-native" && r.platform === "darwin");
    const linux = CAPABILITY_MATRIX.find((r) => r.backend === "local-native" && r.platform === "linux");
    expect(mac?.guarantees.exactCommit).toBe(true);
    expect(mac?.guarantees.hostFilteredEgress).toBe(true);
    expect(linux?.guarantees.exactCommit).toBe(true);
    expect(linux?.guarantees.hostFilteredEgress).toBe(true);
  });

  // spec 019 FR-014 (QS-2.3): exact-commit rows derive from a probe result,
  // never from hardcoded comments. A fake probe with available:false must
  // show the row unavailable on every platform.
  describe("probe-derived exact-commit rows (spec 019 FR-014)", () => {
    it("probe unavailable → exactCommit false on every row", () => {
      const probe = { available: false };
      const mac = lookupPlatformCapability("local-native", "darwin", probe);
      const linux = lookupPlatformCapability("local-native", "linux", probe);
      expect(mac?.guarantees.exactCommit).toBe(false);
      expect(linux?.guarantees.exactCommit).toBe(false);
    });

    it("probe available → exactCommit true exactly where the platform primitive exists", () => {
      const probe = { available: true };
      expect(lookupPlatformCapability("local-native", "darwin", probe)?.guarantees.exactCommit).toBe(true);
      expect(lookupPlatformCapability("local-native", "linux", probe)?.guarantees.exactCommit).toBe(true);
      // No win32 helper: false regardless of probe state.
      expect(lookupPlatformCapability("local-native", "win32", probe)?.guarantees.exactCommit).toBe(false);
      expect(lookupPlatformCapability("local-native", "win32", { available: false })?.guarantees.exactCommit).toBe(false);
    });

    it("renderCapabilityMatrix reflects the probe", () => {
      const off = renderCapabilityMatrix({ available: false });
      const on = renderCapabilityMatrix({ available: true });
      expect(off).not.toContain("exact:✓");
      expect(on).toContain("exact:✓");
    });

    it("static rows stay unchanged without a probe (no false upgrade)", () => {
      // Consumers that do not run a probe must not gain a claim they cannot
      // verify — rows keep their static shape.
      const row = lookupPlatformCapability("local-native", "darwin");
      expect(row?.guarantees.exactCommit).toBe(true);
    });
  });
});
