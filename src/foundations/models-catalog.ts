import { ProviderType } from './contracts/llm.js';

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
    M('gpt-5.6-terra', 'GPT-5.6 Terra', 256000, 2.5, 10),
    M('gpt-5.6-sol', 'GPT-5.6 Sol', 256000, 5, 20),
    M('gpt-5.6-luna', 'GPT-5.6 Luna', 128000, 0.15, 0.6),
    M('gpt-4o', 'GPT-4o', 128000, 2.5, 10),
    M('gpt-4o-mini', 'GPT-4o Mini', 128000, 0.15, 0.6),
    M('gpt-5.4', 'GPT-5.4', 256000, 2.5, 10),
    M('gpt-5.4-pro', 'GPT-5.4 Pro', 256000, 5, 20),
    M('gpt-5.4-mini', 'GPT-5.4 Mini', 128000, 0.15, 0.6),
  ],
  anthropic: [
    M('claude-sonnet-5', 'Claude Sonnet 5', 500000, 3, 15),
    M('claude-opus-5', 'Claude Opus 5', 500000, 15, 75),
    M('claude-haiku-4-5', 'Claude Haiku 4.5', 200000, 0.8, 4),
    M('claude-sonnet-4-6-20260320', 'Claude Sonnet 4.6', 200000, 3, 15),
    M('claude-opus-4-6-20260320', 'Claude Opus 4.6', 200000, 15, 75),
  ],
  glm: [
    M('glm-5.3', 'GLM-5.3', 256000, 1.5, 4.5),
    M('glm-4.7', 'GLM-4.7', 128000, 1, 3),
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
  openai: 'gpt-5.6-terra',
  'openai-compatible': 'gpt-5.6-terra',
  anthropic: 'claude-sonnet-5',
  glm: 'glm-5.3',
};

/** Look up a model's metadata (context window + pricing) by id, across providers.
 *  Case-insensitive — model ids may arrive display-cased (e.g. "Opus" vs "opus"). */
export function getModelMeta(id?: string): ModelEntry | undefined {
  if (!id || typeof id !== "string") return undefined;
  const lower = id.toLowerCase();
  for (const list of Object.values(MODEL_CATALOG)) {
    const found = list.find((m) => m.id.toLowerCase() === lower);
    if (found) return found;
  }
  return undefined;
}

import type { UpstreamModel } from './schemas/inference.js';

export function resolveCuratedCatalog(): UpstreamModel[] {
  const catalog: UpstreamModel[] = [];
  for (const [pType, models] of Object.entries(MODEL_CATALOG)) {
    for (const m of models) {
      catalog.push({
        id: m.id,
        upstreamProvider: pType,
        displayName: m.name,
        contextWindow: m.contextWindow ?? 128_000,
        capabilities: {
          toolUse: true,
          streaming: true,
          vision: m.id.includes("vision") || m.id.includes("gpt-5") || m.id.includes("claude-sonnet") || m.id.includes("o3"),
        },
        pricing: m.pricing
          ? {
              promptPerMillion: m.pricing.input,
              completionPerMillion: m.pricing.output,
            }
          : undefined,
        provenance: "seepient-curated",
      });
    }
  }

  // Curated image models
  catalog.push(
    {
      id: "dall-e-3",
      upstreamProvider: "openai",
      displayName: "DALL-E 3",
      contextWindow: 4096,
      capabilities: {
        toolUse: false,
        streaming: false,
        vision: false,
        imageGenerate: true,
        imageVariation: false,
        imageEdit: false,
        imageMask: false,
        aspectRatios: ["1:1", "16:9", "9:16"],
      },
      provenance: "seepient-curated",
    },
    {
      id: "dall-e-2",
      upstreamProvider: "openai",
      displayName: "DALL-E 2",
      contextWindow: 4096,
      capabilities: {
        toolUse: false,
        streaming: false,
        vision: false,
        imageGenerate: true,
        imageVariation: true,
        imageEdit: true,
        imageMask: true,
        aspectRatios: ["1:1"],
      },
      provenance: "seepient-curated",
    },
    {
      id: "imagen-3.0-generate-002",
      upstreamProvider: "google",
      displayName: "Imagen 3",
      contextWindow: 4096,
      capabilities: {
        toolUse: false,
        streaming: false,
        vision: false,
        imageGenerate: true,
        imageVariation: false,
        imageEdit: false,
        imageMask: false,
        aspectRatios: ["1:1", "16:9", "9:16", "4:3", "3:4"],
      },
      provenance: "seepient-curated",
    },
  );

  return catalog;
}
