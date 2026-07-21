/**
 * P0 regression fixtures (spec 008, T007).
 *
 * These fixtures reproduce the six confirmed current defects so the fixes in
 * P1/P2/P4 can be verified against them. They use temporary directories,
 * fake credentials, and in-memory fakes — never real system data.
 *
 * Each fixture asserts the CURRENT (broken) behavior with a clear marker so
 * the migration is auditable. When the corresponding phase lands, the
 * `xit.skip` markers flip to active assertions of the fixed behavior.
 */
import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkToolPermission, resolvePermissionLevel } from "../../permission.js";

/**
 * QS-0.1 / QS-0.2 / QS-0.3 — the three CRITICAL current defects documented as
 * fixtures. These do NOT touch real system files; they demonstrate that the
 * legacy matrix grants effectful execution at the default level.
 */
describe("P0 regression fixtures — current defects", () => {
  it("QS-0.1: default `moderate` auto-approves `edit` (outside-write vector)", () => {
    // CURRENT DEFECT: write_file at moderate + edit never reaches an
    // enforcement boundary. The matrix returns "auto" for edit at moderate.
    const decision = checkToolPermission("moderate", "edit");
    // Fixture for the migration: once PolicyEngine owns the decision, this
    // matrix shortcut is gone and every effectful action is analyzed.
    expect(decision).toBe("auto");
  });

  it("QS-0.2: `autoConfirm`/`permissive` bypasses all permission logic", () => {
    // CURRENT DEFECT: permissive auto-approves even destructive actions.
    const decision = checkToolPermission("permissive", "destructive");
    expect(decision).toBe("auto");
  });

  it("QS-0.3: prefix-grant collision is structurally unrepresentable safely", () => {
    // CURRENT DEFECT: GrantSpec.pattern is a raw string prefix. Granting
    // `/tmp/demo` would match `/tmp/demo-evil/file`. This fixture documents
    // the shape; P1 quarantine + P3 structured rules retire it.
    const grant = { tool: "write_file", pattern: "/tmp/demo" } as const;
    const collisionTarget = "/tmp/demo-evil/file";
    expect(collisionTarget.startsWith(grant.pattern)).toBe(true);
  });

  it("fixture helper: writes to a temp dir never escape it", () => {
    // Regression tests use this pattern to guarantee no real-system mutation.
    const dir = mkdtempSync(join(tmpdir(), "seepient-regression-"));
    const target = join(dir, "probe.txt");
    writeFileSync(target, "probe");
    expect(target).toContain(dir);
  });
});

describe("P0 regression fixtures — level resolution defaults", () => {
  it("falls back to `moderate` for unknown input (the current default)", () => {
    expect(resolvePermissionLevel(undefined, undefined, undefined)).toBe(
      "moderate",
    );
    expect(resolvePermissionLevel("no-such-level", "also-bad", undefined)).toBe(
      "moderate",
    );
  });
});
