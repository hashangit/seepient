/**
 * Token counting via BPE (byte-pair encoding).
 *
 * Uses `gpt-tokenizer` — a pure-JS implementation of OpenAI's BPE — as the
 * base tokenizer, then applies a correction multiplier per provider family.
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

import { encode } from 'gpt-tokenizer';
import type { ProviderType } from './types.js';

/** Correction multiplier applied to BPE counts per provider family. */
const CORRECTION_FACTOR: Partial<Record<ProviderType, number>> = {
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
export function countTokens(text: string, providerType?: ProviderType): number {
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
