/**
 * Exact-BPE estimator registration — Capabilities (spec 027 FR-004).
 *
 * Registers the lazy gpt-tokenizer loader into the foundation seam. Lives in
 * Capabilities because src/vendors/ imports are forbidden from Transport and
 * UI (S-12); the full package's composition roots call this once at load.
 */
import { registerExactEstimatorLoader } from "../../foundations/injection-seams.js";

export function registerExactEstimator(): void {
  registerExactEstimatorLoader(async () => import("../../vendors/gpt-tokenizer.js"));
}
