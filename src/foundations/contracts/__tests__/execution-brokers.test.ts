import { describe, it, expect, vi } from "vitest";
import { isLocalAuditStore } from "../execution-brokers.js";

describe("isLocalAuditStore truth table (Spec 021-2 / E10, E13, E14, FR-013)", () => {
  it("returns true for LocalAuditStore instances", () => {
    class LocalAuditStore {}
    const store = new LocalAuditStore();
    expect(isLocalAuditStore(store)).toBe(true);
  });

  it("returns true when isLocal: true is explicitly declared on custom store", () => {
    const customStore = {
      isLocal: true,
      append: vi.fn(),
      getTerminal: vi.fn(),
    };
    expect(isLocalAuditStore(customStore)).toBe(true);
  });

  it("returns false when isLocal: false is explicitly declared even if named LocalAuditStore", () => {
    const remoteStore = {
      isLocal: false,
      append: vi.fn(),
      getTerminal: vi.fn(),
    };
    expect(isLocalAuditStore(remoteStore)).toBe(false);
  });

  it("returns false when isLocal is undefined on non-LocalAuditStore custom store", () => {
    const customStore = {
      append: vi.fn(),
      getTerminal: vi.fn(),
    };
    expect(isLocalAuditStore(customStore)).toBe(false);
  });

  it("returns false for non-store or nil values", () => {
    expect(isLocalAuditStore(null)).toBe(false);
    expect(isLocalAuditStore(undefined)).toBe(false);
    expect(isLocalAuditStore({})).toBe(false);
    expect(isLocalAuditStore("string")).toBe(false);
  });
});
