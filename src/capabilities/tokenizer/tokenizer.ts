/**
 * Token counting via BPE (byte-pair encoding) with a heuristic fallback.
 *
 * Uses `gpt-tokenizer` — a pure-JS implementation of OpenAI's BPE — as the
 * base tokenizer, then applies a correction multiplier per provider family.
 * The vendor loads lazily (spec 027 FR-004): the full package resolves the
 * exact-BPE module; core-only installs keep a chars÷4 heuristic with no hard
 * dependency, and the active mode is observable via `currentEstimateMode()` /
 * `whenEstimatorReady`.
 *
 * The base BPE is exact for OpenAI-family models. Anthropic and GLM use
 * different (unpublished) BPE vocabularies; empirically, tiktoken/gpt-tokenizer
 * *undercounts* their tokens, so we multiply up:
 *   - Claude (3/4): tiktoken undercounts by ~15-20% → ×1.2
 *     (ref: https://dev.to/pavelespitia/token-counting-done-right-stop-using-tiktoken-for-claude-383c)
 *   - GLM: similar BPE structure, slightly more tokens → ×1.15
 *
 * These are best-effort corrections — the only exact path is the provider's
 * own usage API (returned in the response), which is what the footer's
 * context-token number uses. This module is for *breakdowns* the API can't
 * provide (per-part: system vs tools vs skills vs history).
 */

import { getExactEstimatorLoader } from "../../foundations/injection-seams.js";

type EncodeFn = (text: string) => number[];

function heuristicEncode(text: string): number[] {
  // chars÷4 fallback: ~4 characters per token for English prose.
  return new Array(Math.max(1, Math.ceil(text.length / 4))).fill(0);
}

let encode: EncodeFn = heuristicEncode;
let estimateMode: "exact" | "heuristic" = "heuristic";

/**
 * Settles once the exact-BPE loader (registered by the full package) resolves
 * or fails. Resolves with the active estimate mode — "exact" when the vendor
 * is present, "heuristic" when it is unregistered/unresolvable (core-only
 * installs, spec 027 FR-004).
 */
let readyPromise: Promise<"exact" | "heuristic"> | undefined;

/**
 * Settles once the exact-BPE loader (registered by the full package) resolves
 * or fails. Resolves with the active estimate mode — "exact" when the vendor
 * is present, "heuristic" when it is unregistered/unresolvable (core-only
 * installs, spec 027 FR-004). Lazy: call AFTER registration.
 */
export function whenEstimatorReady(): Promise<"exact" | "heuristic"> {
  readyPromise ??= getExactEstimatorLoader()?.().then(
    (m) => {
      encode = m.encode;
      estimateMode = "exact";
      return estimateMode;
    },
    () => {
      // A failed load pins heuristic honestly — the mode must reflect what
      // this process will actually count with.
      estimateMode = "heuristic";
      return estimateMode;
    },
  ) ?? Promise.resolve(estimateMode);
  return readyPromise;
}

/**
 * Forget a settled readiness memo (spec 027 review P1-1). A core-only turn
 * that settles "heuristic" before the full package registers its loader must
 * not pin heuristic forever — registration resets this memo and arms the
 * load (see `registerExactEstimator`).
 */
export function resetEstimatorMemo(): void {
  readyPromise = undefined;
}

/** The active token-estimate mode ("exact" | "heuristic"). */
export function currentEstimateMode(): "exact" | "heuristic" {
  return estimateMode;
}

/** Correction multiplier applied to BPE counts per provider family. */
const CORRECTION_FACTOR: Record<string, number> = {
  openai: 1.0,
  'openai-compatible': 1.0,
  anthropic: 1.2,
  glm: 1.15,
};

/**
 * Count tokens in `text` using BPE, corrected for the provider family.
 * Falls back to chars÷4 on encode errors (rare unicode edge cases).
 * Empty/undefined input returns 0.
 */
export function countTokens(text: string, providerType?: string): number {
  if (!text) return 0;
  let raw: number;
  try {
    raw = encode(text).length;
  } catch {
    raw = Math.ceil(text.length / 4);
  }
  const factor = providerType ? (CORRECTION_FACTOR[providerType] ?? 1.0) : 1.0;
  return Math.ceil(raw * factor);
}

/**
 * Whether the count is corrected (non-OpenAI providers use a multiplier).
 * Kept for callers that want to know if the value is exact or estimated.
 */
export function isCorrected(providerType?: string): boolean {
  return providerType !== 'openai' && providerType !== 'openai-compatible';
}
