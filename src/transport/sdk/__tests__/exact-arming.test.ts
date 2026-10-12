/**
 * Spec 027 review P1-1 (FR-004): the exact-BPE estimator must ARM on full
 * registration. Pre-fix, registerExactEstimator only stored a loader no
 * production code ever invoked — the full package silently counted with the
 * chars÷4 heuristic forever while the CHANGELOG claimed "exact". These pins
 * live in their own file because they exercise the FULL composition;
 * the seam gates file asserts core-only defaults and must stay
 * registration-free.
 */
import { describe, it, expect } from "vitest";

describe("exact-BPE arming (review P1-1)", () => {
  it("importing the full registrations arms exact mode", async () => {
    await import("../full-registrations.js");
    const { whenEstimatorReady, currentEstimateMode } = await import(
      "../../../capabilities/tokenizer/tokenizer.js"
    );
    const mode = await whenEstimatorReady();
    expect(mode).toBe("exact");
    expect(currentEstimateMode()).toBe("exact");
  });

  it("a late registration re-arms after a heuristic-settled memo", async () => {
    const { registerExactEstimatorLoader } = await import(
      "../../../foundations/injection-seams.js"
    );
    const {
      whenEstimatorReady,
      resetEstimatorMemo,
    } = await import("../../../capabilities/tokenizer/tokenizer.js");

    const { registerExactEstimator } = await import(
      "../../../capabilities/tokenizer/register-exact-estimator.js"
    );

    // Fresh process: a core-only turn settles heuristic first (memo pinned).
    // (Reset first — this file's earlier case already armed the memo; in
    // production the core-only turn runs in a graph that never registered.)
    resetEstimatorMemo();
    registerExactEstimatorLoader(() =>
      Promise.reject(new Error("simulated core-only: vendor absent")),
    );
    expect(await whenEstimatorReady()).toBe("heuristic");

    // The full package registers late — the memo must reset and re-arm.
    registerExactEstimator();
    expect(await whenEstimatorReady()).toBe("exact");
    resetEstimatorMemo(); // leave the shared memo clean for other cases
  });
});
