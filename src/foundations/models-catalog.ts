import type { UpstreamModel } from './schemas/inference.js';
import { SeepientError } from './errors.js';

/**
 * Per-model metadata. `contextWindow` is the max context in tokens;
 * `pricing` is USD per 1M tokens (input / output).
 */
export interface ModelEntry {
  id: string;
  name: string;
  contextWindow?: number;
  pricing?: { input: number; output: number }; // $ / 1M tokens
}

export const CUSTOM_MODEL_VALUE = '__custom__';

/**
 * Provider alias mapping between Seepient provider types and upstream community catalog identifiers.
 * e.g. 'glm' in Seepient routes to 'zai' in the Pi/community catalog.
 */
export const PROVIDER_ALIASES: Record<string, string> = {
  glm: 'zai',
  'openai-compatible': 'openai',
};

export function normalizeProviderName(provider: string): string {
  return PROVIDER_ALIASES[provider] || provider;
}

export type CatalogAccessor = () => readonly UpstreamModel[];

let globalCatalogAccessor: CatalogAccessor | null = null;

export function registerCatalogAccessor(accessor: CatalogAccessor): void {
  globalCatalogAccessor = accessor;
}

export function getSyncCatalogSnapshot(): readonly UpstreamModel[] {
  if (globalCatalogAccessor) {
    return globalCatalogAccessor();
  }
  return [];
}

/**
 * Extracts a numeric version tuple from a model ID representing its generation.
 * e.g. "gpt-5.6-terra" -> [5, 6], "claude-opus-4-8" -> [4, 8], "deepseek-v4-pro" -> [4],
 * "o3-pro" -> [3], "glm-5.3" -> [5, 3], date-style suffixes -> [0], no-version -> [0].
 */
export function extractGeneration(id: string): number[] {
  // Strip date-style suffixes (e.g. 04-2026, 2026-04-01, 20260401, 2026) so they are not treated as generations
  const cleaned = id.replace(/(?:^|[-_])(?:\d{2}-20\d{2}|20\d{2}-\d{2}(?:-\d{2})?|20\d{2}\d{4}|20\d{2})(?:[-_]|$)/gi, '-');

  // Match version-like segment: prefix v/o/r or start/separator, then numbers separated by dots or hyphens
  const match = cleaned.match(/(?:^|[-_])(?:v|o|r)?(\d+(?:[.-]\d+)*)(?:[-_]|$)/i);
  if (!match) {
    return [0];
  }

  const parts = match[1]
    .split(/[.-]/)
    .map((s) => parseInt(s, 10))
    .filter((n) => !isNaN(n));

  return parts.length > 0 ? parts : [0];
}

/**
 * Compares two generation tuples numerically.
 * Returns > 0 if a > b, < 0 if a < b, and 0 if equal.
 * e.g. [5, 10] > [5, 6].
 */
export function compareGenerations(a: readonly number[], b: readonly number[]): number {
  const maxLen = Math.max(a.length, b.length);
  for (let i = 0; i < maxLen; i++) {
    const valA = a[i] ?? 0;
    const valB = b[i] ?? 0;
    if (valA !== valB) {
      return valA - valB;
    }
  }
  return 0;
}

/**
 * Scores an UpstreamModel for a specific purpose tier based on capability, context, pricing, and name hints.
 */
export function scoreModelForTier(
  model: UpstreamModel,
  tier: 'efficient' | 'standard' | 'complex',
): number {
  let score = 0;

  if (tier === 'complex') {
    // 1. Reasoning Weight (+50 pts): Has reasoning support
    if (model.supportedReasoningLevels && model.supportedReasoningLevels.length > 1) {
      score += 50;
    }
    // 2. Context Window Weight (+20 pts): Context window >= 200k tokens
    if ((model.contextWindow ?? 0) >= 200000) {
      score += 20;
    }
    // 3. Name Heuristics (+30 pts): Matches /opus|sol|r1|o1|o3|thinking|max|pro/i
    if (/opus|sol|r1|o1|o3|thinking|max|pro/i.test(model.id)) {
      score += 30;
    }
  } else if (tier === 'efficient') {
    // 1. Pricing Weight (+50 pts): Input pricing <= $1.00 / 1M tokens
    if (model.pricing?.promptPerMillion !== undefined && model.pricing.promptPerMillion <= 1.0) {
      score += 50;
    }
    // 2. Speed / Air / Flash Name Heuristics (+40 pts): Matches /haiku|flash|luna|nano|mini|27b|8b|4\.5-air|air|lite/i
    if (/haiku|flash|luna|nano|mini|27b|8b|4\.5-air|air|lite/i.test(model.id)) {
      score += 40;
    }
    // 3. Context Window Balance (+10 pts): Context window >= 128k tokens
    if ((model.contextWindow ?? 0) >= 128000) {
      score += 10;
    }
  } else {
    // Standard Tier ('standard')
    // 1. Balanced Capabilities (+40 pts): Supports toolUse, vision, and streaming
    if (
      model.capabilities?.toolUse !== false &&
      model.capabilities?.streaming !== false &&
      model.capabilities?.vision === true
    ) {
      score += 40;
    }
    // 2. Workhorse Name Heuristics (+40 pts): Matches /sonnet|terra|5\.3|5\.2|v4|4\.6|4\.5/i
    if (/sonnet|terra|5\.3|5\.2|v4|4\.6|4\.5/i.test(model.id)) {
      score += 40;
    }
    // 3. Context Window (+20 pts): Context window >= 200k tokens
    if ((model.contextWindow ?? 0) >= 200000) {
      score += 20;
    }
  }

  return score;
}

/**
 * Dynamically resolves the best default model for a given provider and tier from an UpstreamModel catalog.
 * Fails loudly with an actionable UNCONFIGURED_PROVIDER error when no candidates match.
 */
export function resolveDefaultModelForProvider(
  catalog: readonly UpstreamModel[],
  provider: string,
  tier: 'efficient' | 'standard' | 'complex' = 'standard',
): string {
  const aliased = normalizeProviderName(provider);
  const candidates = catalog.filter(
    (m) =>
      (m.upstreamProvider === provider ||
        m.upstreamProvider === aliased ||
        (m as any).provider === provider ||
        (m as any).provider === aliased) &&
      m.capabilities?.toolUse !== false &&
      m.capabilities?.streaming !== false,
  );

  if (candidates.length === 0) {
    throw new SeepientError(
      `No candidate models found in catalog for provider "${provider}". Please configure a valid model.`,
      'UNCONFIGURED_PROVIDER',
      false,
    );
  }

  const scored = candidates.map((m) => ({
    model: m,
    score: scoreModelForTier(m, tier),
    generation: extractGeneration(m.id),
  }));

  // Deterministic tie-breaking:
  // score (desc) -> generation (desc) -> contextWindow (desc) -> id length (asc: prefer clean base ids over suffixed snapshots) -> id (desc)
  scored.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    const genCmp = compareGenerations(b.generation, a.generation);
    if (genCmp !== 0) {
      return genCmp;
    }
    const ctxA = a.model.contextWindow ?? 0;
    const ctxB = b.model.contextWindow ?? 0;
    if (ctxB !== ctxA) {
      return ctxB - ctxA;
    }
    const lenDiff = a.model.id.length - b.model.id.length;
    if (lenDiff !== 0) {
      return lenDiff;
    }
    return b.model.id.localeCompare(a.model.id);
  });

  return scored[0].model.id;
}

/**
 * Synchronous policy default model resolver helper using available catalog snapshot.
 */
export function resolveDefaultModel(
  provider: string,
  tier: 'efficient' | 'standard' | 'complex' = 'standard',
): string {
  const catalog = getSyncCatalogSnapshot();
  if (catalog.length > 0) {
    return resolveDefaultModelForProvider(catalog, provider, tier);
  }
  throw new SeepientError(
    `No default model could be resolved for provider "${provider}": catalog snapshot is empty. Ensure catalog is initialized.`,
    "NO_CANDIDATE_TARGETS",
    false,
  );
}

/**
 * Look up a model's metadata (context window + pricing) by id across the community catalog snapshot.
 */
export function getModelMeta(id?: string): ModelEntry | undefined {
  if (!id || typeof id !== 'string') return undefined;
  const catalog = getSyncCatalogSnapshot();
  const lower = id.toLowerCase();
  const found = catalog.find(
    (m) => m.id.toLowerCase() === lower || m.id.toLowerCase().endsWith('/' + lower),
  );
  if (!found) return undefined;
  const pricing =
    found.pricing &&
    typeof found.pricing.promptPerMillion === 'number' &&
    typeof found.pricing.completionPerMillion === 'number'
      ? {
          input: found.pricing.promptPerMillion,
          output: found.pricing.completionPerMillion,
        }
      : undefined;

  return {
    id: found.id,
    name: found.displayName,
    contextWindow: found.contextWindow,
    pricing,
  };
}


