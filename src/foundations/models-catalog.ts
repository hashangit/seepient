import { ProviderType } from './contracts/llm.js';
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

  if (tier === 'complex') {
    const reasoning =
      candidates.find((m) => /opus|sol|r1|o1|o3|thinking|max/i.test(m.id)) ||
      candidates.find((m) => m.supportedReasoningLevels && m.supportedReasoningLevels.length > 1);
    return reasoning ? reasoning.id : candidates[0].id;
  }

  if (tier === 'efficient') {
    const fast = candidates.find((m) =>
      /haiku|flash|luna|mini|27b|8b|4\.5-air|air/i.test(m.id),
    );
    return fast ? fast.id : candidates[candidates.length - 1].id;
  }

  if (tier === 'standard') {
    const standards = candidates.filter((m) =>
      /sonnet|terra|pro|5\.3|5\.4/i.test(m.id),
    );
    if (standards.length > 0) {
      const highest =
        standards.find((m) => /sonnet-5|terra|5\.3/i.test(m.id)) ||
        standards[standards.length - 1];
      return highest.id;
    }
    return candidates[0].id;
  }

  return candidates[0].id;
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

/**
 * Dynamic policy-backed defaults proxy.
 */
export const DEFAULT_MODELS: Record<ProviderType, string> = {
  get openai() {
    return resolveDefaultModel('openai', 'standard');
  },
  get 'openai-compatible'() {
    return resolveDefaultModel('openai-compatible', 'standard');
  },
  get anthropic() {
    return resolveDefaultModel('anthropic', 'standard');
  },
  get glm() {
    return resolveDefaultModel('glm', 'standard');
  },
};

/**
 * Dynamic catalog entries grouped by provider type for CLI setup and TUI.
 */
export const MODEL_CATALOG: Record<ProviderType, ModelEntry[]> = new Proxy(
  {} as Record<ProviderType, ModelEntry[]>,
  {
    get(_target, prop: string) {
      if (typeof prop !== 'string') return undefined;
      const catalog = getSyncCatalogSnapshot();
      const aliased = normalizeProviderName(prop);
      const matched = catalog.filter(
        (m) => m.upstreamProvider === aliased || m.upstreamProvider === prop,
      );
      return matched.map((m) => ({
        id: m.id,
        name: m.displayName,
        contextWindow: m.contextWindow,
        pricing: m.pricing
          ? {
              input: m.pricing.promptPerMillion ?? 0,
              output: m.pricing.completionPerMillion ?? 0,
            }
          : undefined,
      }));
    },
    ownKeys() {
      return ['openai', 'anthropic', 'glm', 'openai-compatible'];
    },
    getOwnPropertyDescriptor() {
      return { enumerable: true, configurable: true };
    },
  },
);
