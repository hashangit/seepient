/**
 * Context-breakdown contract — the display vocabulary for where the context
 * budget went. Computed by Domain (`domain/context/context-breakdown.ts`),
 * rendered by Transport (`/context`) and UI (context panel); all three speak
 * to this contract instead of importing each other.
 */

import type { ProviderType } from '../types.js';

export interface ContextBreakdownPart {
  /** Display label, e.g. "System Prompt". */
  label: string;
  /** Token count for this part (corrected for the active model family). */
  tokens: number;
  /** Sub-detail string, e.g. "15 tools", "8 messages". */
  detail: string;
}

export interface ContextBreakdown {
  parts: ContextBreakdownPart[];
  /** Sum of all part token counts. */
  total: number;
  /** Active model's max context window, if known. */
  contextWindow?: number;
  /** Active model name (for display). */
  model: string;
  /** Provider type (for display). */
  providerType?: ProviderType;
}
