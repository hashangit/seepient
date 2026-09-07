/**
 * Spec 022 — Tenancy Mode & Fail-Closed Validation Unit Tests (T008).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  resolveTenancyMode,
  validateTenancyCompleteness,
  TenancyRuntimeRequiredError,
  TenancyStoreIncompleteError,
  TenancyAmbientIoError,
  emitTenancyNoticeOnce,
  resetTenancyNoticeForTest,
  type TenancySignals,
} from "../tenancy-mode.js";

describe("Tenancy Mode Resolution (T008)", () => {
  it("Row 1: explicit 'multi' resolves to multi without upgrade notice", () => {
    const res = resolveTenancyMode({ explicit: "multi" });
    expect(res).toEqual({ mode: "multi", upgraded: false });
  });

  it("Row 2: explicit 'single' resolves to single even when injection signals are present", () => {
    const res = resolveTenancyMode({
      explicit: "single",
      principalIdSet: true,
      anyStoreInjected: true,
      runtimeInjected: true,
    });
    expect(res).toEqual({ mode: "single", upgraded: false });
  });

  it("Row 3a: no explicit mode + principalIdSet resolves to multi with upgrade notice", () => {
    const res = resolveTenancyMode({ principalIdSet: true });
    expect(res).toEqual({ mode: "multi", upgraded: true });
  });

  it("Row 3b: no explicit mode + anyStoreInjected resolves to multi with upgrade notice", () => {
    const res = resolveTenancyMode({ anyStoreInjected: true });
    expect(res).toEqual({ mode: "multi", upgraded: true });
  });

  it("Row 3c: no explicit mode + runtimeInjected resolves to multi with upgrade notice", () => {
    const res = resolveTenancyMode({ runtimeInjected: true });
    expect(res).toEqual({ mode: "multi", upgraded: true });
  });

  it("Row 3d: no explicit mode + persistInjected resolves to multi with upgrade notice", () => {
    const res = resolveTenancyMode({ persistInjected: true });
    expect(res).toEqual({ mode: "multi", upgraded: true });
  });

  it("Row 3e: no explicit mode + skillSourcesInjected resolves to multi with upgrade notice", () => {
    const res = resolveTenancyMode({ skillSourcesInjected: true });
    expect(res).toEqual({ mode: "multi", upgraded: true });
  });

  it("Row 4: no explicit mode + no injection signals resolves to single", () => {
    const res = resolveTenancyMode({});
    expect(res).toEqual({ mode: "single", upgraded: false });
  });
});

describe("Tenancy Completeness Validation & UX Errors (T008)", () => {
  it("passes silently in single mode even if stores or runtime are missing", () => {
    expect(() =>
      validateTenancyCompleteness("single", {
        runtime: undefined,
        auditStore: undefined,
      }),
    ).not.toThrow();
  });

  it("throws TenancyRuntimeRequiredError if runtime is missing in multi mode with actionable copy", () => {
    try {
      validateTenancyCompleteness("multi", {
        runtime: undefined,
        auditStore: {},
        policyStore: {},
        capabilityLedger: {},
      });
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(err).toBeInstanceOf(TenancyRuntimeRequiredError);
      expect(err.code).toBe("TENANCY_RUNTIME_REQUIRED");
      expect(err.retryable).toBe(false);
      // UX copy assertions
      expect(err.message).toContain("runtime");
      expect(err.message).toContain('tenancy: "single"');
    }
  });

  it("throws TenancyStoreIncompleteError if any permission store is missing in multi mode", () => {
    try {
      validateTenancyCompleteness("multi", {
        runtime: {},
        auditStore: {},
        policyStore: undefined,
        capabilityLedger: {},
      });
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(err).toBeInstanceOf(TenancyStoreIncompleteError);
      expect(err.code).toBe("TENANCY_STORE_INCOMPLETE");
      expect(err.retryable).toBe(false);
      expect(err.missingStores).toEqual(["policyStore"]);
      // UX copy assertions
      expect(err.message).toContain("policyStore");
      expect(err.message).toContain("Inject");
      expect(err.message).toContain("stateless: true");
    }
  });

  it("allows stateless: true agent without persist backend when permission stores are injected", () => {
    expect(() =>
      validateTenancyCompleteness("multi", {
        runtime: {},
        auditStore: {},
        policyStore: {},
        capabilityLedger: {},
        isSessionful: true,
        stateless: true,
      }),
    ).not.toThrow();
  });

  it("rejects stateless: true in multi mode when permission stores are missing", () => {
    expect(() =>
      validateTenancyCompleteness("multi", {
        runtime: {},
        isSessionful: false,
        stateless: true,
      }),
    ).toThrow(TenancyStoreIncompleteError);
  });

  it("requires persist backend in sessionful multi mode when stateless is not declared", () => {
    expect(() =>
      validateTenancyCompleteness("multi", {
        runtime: {},
        auditStore: {},
        policyStore: {},
        capabilityLedger: {},
        isSessionful: true,
        stateless: false,
      }),
    ).toThrow(TenancyStoreIncompleteError);
  });

  it("TenancyAmbientIoError carries actionable remediation copy", () => {
    const err = new TenancyAmbientIoError("~/.seepient/settings.json");
    expect(err.code).toBe("TENANCY_AMBIENT_IO");
    expect(err.retryable).toBe(false);
    expect(err.targetPath).toBe("~/.seepient/settings.json");
    expect(err.message).toContain("~/.seepient/settings.json");
    expect(err.message).toContain("injected");
  });
});

describe("One-time Tenancy Upgrade Notice (T008)", () => {
  beforeEach(() => {
    resetTenancyNoticeForTest();
  });

  it("prints the upgrade notice exactly once when upgraded is true", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    emitTenancyNoticeOnce(true);
    emitTenancyNoticeOnce(true);
    emitTenancyNoticeOnce(true);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('upgraded to "multi"');
    expect(warnSpy.mock.calls[0][0]).toContain('tenancy: "single"');

    warnSpy.mockRestore();
  });

  it("does not print notice when upgraded is false", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    emitTenancyNoticeOnce(false);
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});
