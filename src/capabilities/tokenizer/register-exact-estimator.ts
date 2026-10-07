/**
 * Exact-BPE estimator registration — Capabilities (spec 027 FR-004).
 *
 * Registers the lazy gpt-tokenizer loader into the foundation seam. Lives in
 * Capabilities because src/vendors/ imports are forbidden from Transport and
 * UI (S-12); the full package's composition roots call this once at load.
 */
import { registerExactEstimatorLoader } from "seepient-core/dist/foundations/injection-seams.js";
import { resetEstimatorMemo, whenEstimatorReady } from "seepient-core/dist/capabilities/tokenizer/tokenizer.js";

export function registerExactEstimator(): void {
  registerExactEstimatorLoader(async () => import("../../vendors/gpt-tokenizer.js"));
  // Review P1-1 (FR-004): storing the loader arms nothing by itself — the
  // exact-BPE module must actually LOAD here, fire-and-forget, so the first
  // turn already counts exactly. A memo settled "heuristic" by an earlier
  // core-only turn is reset so a late registration re-arms.
  resetEstimatorMemo();
  void whenEstimatorReady().catch(() => {
    /* vendor unresolvable — heuristic stays; whenEstimatorReady already settled */
  });
}
