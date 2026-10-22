import { describe, expect, it } from "vitest";
import type { ActionApprovalRule } from "@seepients/core";
import {
  effectiveApprovalRules,
  effectiveAutoReviewPreference,
  effectiveDisabledBuiltinTools,
  runLeaseHeldAtDispatch,
} from "./executor.js";

const rule = (effect: string, matchKind: string, matchValue: string): ActionApprovalRule =>
  ({ effect, matchKind, matchValue }) as ActionApprovalRule;

describe("FR-009 execution-time revalidation", () => {
  it("runLeaseHeldAtDispatch: owner+fence must both be current", () => {
    expect(runLeaseHeldAtDispatch({ leaseOwner: "w1", leaseFence: 3 }, "w1", 3)).toBe(true);
    expect(runLeaseHeldAtDispatch({ leaseOwner: "w2", leaseFence: 3 }, "w1", 3)).toBe(false);
    expect(runLeaseHeldAtDispatch({ leaseOwner: "w1", leaseFence: 2 }, "w1", 3)).toBe(false);
    // A fenced/absent row (reaped by a newer attempt) refuses.
    expect(runLeaseHeldAtDispatch(null, "w1", 3)).toBe(false);
    expect(runLeaseHeldAtDispatch(undefined, "w1", 3)).toBe(false);
  });

  it("effectiveDisabledBuiltinTools: mid-run disables apply, removals do not loosen", () => {
    const effective = effectiveDisabledBuiltinTools(["shell"], ["computer_act", "message_bot"]);
    expect(effective.has("shell")).toBe(true);
    expect(effective.has("computer_act")).toBe(true);
    expect(effective.has("message_bot")).toBe(true);
    // Removing "shell" from the live config mid-run keeps it disabled for the run.
    const afterRemoval = effectiveDisabledBuiltinTools(["shell"], []);
    expect(afterRemoval.has("shell")).toBe(true);
    expect(effectiveDisabledBuiltinTools([], null).size).toBe(0);
    // A bot row without the field (undefined snapshot) is tolerated.
    expect(effectiveDisabledBuiltinTools(undefined, ["shell"]).has("shell")).toBe(true);
  });

  it("effectiveApprovalRules: snapshot ∪ current, added rules apply, removed rules never loosen", () => {
    const snapshot = [rule("shell.execute", "tool", "shell"), rule("memory.write", "tool", "remember")];
    const current = [
      // Overlapping rule (same triple) — must not duplicate.
      rule("shell.execute", "tool", "shell"),
      // Added mid-run — applies at dispatch.
      rule("computer.act", "tool", "computer_act"),
    ];
    const effective = effectiveApprovalRules(snapshot, current);
    expect(effective).toHaveLength(3);
    expect(effective.map((r) => r.matchValue)).toEqual(
      expect.arrayContaining(["shell", "remember", "computer_act"]),
    );
    // Current removed the memory rule — the run keeps it (no loosening).
    const loosened = effectiveApprovalRules(snapshot, [rule("computer.act", "tool", "computer_act")]);
    expect(loosened.map((r) => r.matchValue)).toEqual(
      expect.arrayContaining(["shell", "remember", "computer_act"]),
    );
  });

  it("effectiveAutoReviewPreference: mid-run changes may enable review, never silently disable it", () => {
    expect(effectiveAutoReviewPreference(true, false)).toBe(true);
    expect(effectiveAutoReviewPreference(false, true)).toBe(true);
    expect(effectiveAutoReviewPreference(false, false)).toBe(false);
    expect(effectiveAutoReviewPreference(true, true)).toBe(true);
  });
});
