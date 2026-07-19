import { ProviderType } from './providers/types.js';

/**
 * Per-model metadata. `contextWindow` is the max context in tokens;
 * `pricing` is USD per 1M tokens (input / output). Pricing is approximate and
 * editable — providers change it often; this is a reasonable default for the
 * footer's cost + context-window display.
 */
export interface ModelEntry {
  id: string;
  name: string;
  contextWindow?: number;
  pricing?: { input: number; output: number }; // $ / 1M tokens
}

const M = (id: string, name: string, contextWindow: number, input: number, output: number): ModelEntry => ({
  id, name, contextWindow, pricing: { input, output },
});

export const MODEL_CATALOG: Record<ProviderType, ModelEntry[]> = {
  'openai-compatible': [], // No curated list — user provides their own model name
  openai: [
    M('gpt-5.4', 'GPT-5.4', 256000, 2.5, 10),
    M('gpt-5.4-pro', 'GPT-5.4 Pro', 256000, 5, 20),
    M('gpt-5.4-mini', 'GPT-5.4 Mini', 128000, 0.15, 0.6),
    M('gpt-5.4-nano', 'GPT-5.4 Nano', 128000, 0.05, 0.2),
    M('gpt-5.3-instant', 'GPT-5.3 Instant', 128000, 0.5, 2),
    M('gpt-5.3-codex', 'GPT-5.3 Codex', 256000, 2, 8),
    M('o3', 'o3', 200000, 5, 15),
    M('o3-mini', 'o3 Mini', 200000, 1, 4),
  ],
  anthropic: [
    M('claude-sonnet-4-6-20260320', 'Claude Sonnet 4.6', 200000, 3, 15),
    M('claude-opus-4-6-20260320', 'Claude Opus 4.6', 200000, 15, 75),
    M('claude-haiku-4-5-20251001', 'Claude Haiku 4.5', 200000, 0.8, 4),
  ],
  glm: [
    M('haiku', 'GLM-4.5 Air', 128000, 0.5, 1.5),
    M('sonnet', 'GLM-4.7', 128000, 1, 3),
    M('opus', 'GLM-5.1', 128000, 2, 6),
  ],
};

export const CUSTOM_MODEL_VALUE = '__custom__';

/**
 * Default model ID for each provider.
 * Single source of truth — all other files import from here.
 */
export const DEFAULT_MODELS: Record<ProviderType, string> = {
  openai: 'gpt-5.4',
  anthropic: 'claude-sonnet-4-6-20260320',
  glm: 'opus',
  'openai-compatible': 'gpt-5.4',
};

/** Look up a model's metadata (context window + pricing) by id, across providers.
 *  Case-insensitive — model ids may arrive display-cased (e.g. "Opus" vs "opus"). */
export function getModelMeta(id: string): ModelEntry | undefined {
  const lower = id.toLowerCase();
  for (const list of Object.values(MODEL_CATALOG)) {
    const found = list.find((m) => m.id.toLowerCase() === lower);
    if (found) return found;
  }
  return undefined;
}
