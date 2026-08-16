import type { UpstreamModel } from "../../foundations/schemas/inference.js";
import type { CatalogSource } from "../../foundations/contracts/backend-ports.js";

/**
 * Curated baseline models shipped with Seepient.
 */
export const CURATED_MODELS: readonly UpstreamModel[] = [
  {
    id: "gpt-4o",
    upstreamProvider: "openai",
    displayName: "GPT-4o",
    contextWindow: 128_000,
    capabilities: {
      toolUse: true,
      streaming: true,
      vision: true,
    },
    provenance: "seepient-curated",
  },
  {
    id: "gpt-4o-mini",
    upstreamProvider: "openai",
    displayName: "GPT-4o mini",
    contextWindow: 128_000,
    capabilities: {
      toolUse: true,
      streaming: true,
      vision: true,
    },
    provenance: "seepient-curated",
  },
  {
    id: "dall-e-3",
    upstreamProvider: "openai",
    displayName: "DALL-E 3",
    contextWindow: 32_000,
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
    contextWindow: 32_000,
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
    id: "claude-3-7-sonnet-20250219",
    upstreamProvider: "anthropic",
    displayName: "Claude 3.7 Sonnet",
    contextWindow: 200_000,
    capabilities: {
      toolUse: true,
      streaming: true,
      vision: true,
    },
    supportedReasoningLevels: ["none", "low", "medium", "high"],
    provenance: "seepient-curated",
  },
  {
    id: "claude-3-5-haiku-20241022",
    upstreamProvider: "anthropic",
    displayName: "Claude 3.5 Haiku",
    contextWindow: 200_000,
    capabilities: {
      toolUse: true,
      streaming: true,
      vision: true,
    },
    provenance: "seepient-curated",
  },
  {
    id: "gemini-3.1-flash-image",
    upstreamProvider: "google",
    displayName: "Gemini 3.1 Flash Image",
    contextWindow: 32_000,
    capabilities: {
      toolUse: false,
      streaming: false,
      vision: true,
      imageGenerate: true,
      imageVariation: true,
      imageEdit: true,
      imageMask: true,
    },
    provenance: "seepient-curated",
  },
  {
    id: "gemini-2.5-flash-image",
    upstreamProvider: "google",
    displayName: "Gemini 2.5 Flash Image",
    contextWindow: 32_000,
    capabilities: {
      toolUse: false,
      streaming: false,
      vision: true,
      imageGenerate: true,
      imageVariation: false,
      imageEdit: false,
      imageMask: false,
    },
    provenance: "seepient-curated",
  },
];

/**
 * Merges multiple catalog sources with curated defaults and user-declared models.
 * Higher priority sources override lower priority attributes while merging capabilities.
 */
export async function mergeCatalogs(
  sources: CatalogSource[],
  userDeclared: UpstreamModel[] = [],
): Promise<UpstreamModel[]> {
  const modelMap = new Map<string, UpstreamModel>();

  // 1. Base curated models
  for (const m of CURATED_MODELS) {
    const key = `${m.upstreamProvider}:${m.id}`;
    modelMap.set(key, { ...m, capabilities: { ...m.capabilities } });
  }

  // 2. Dynamic catalog sources (e.g. Pi, Google, OpenAI)
  for (const source of sources) {
    try {
      const models = await source.list();
      for (const m of models) {
        const key = `${m.upstreamProvider}:${m.id}`;
        const existing = modelMap.get(key);
        if (existing) {
          modelMap.set(key, {
            ...existing,
            ...m,
            capabilities: {
              ...existing.capabilities,
              ...m.capabilities,
            },
          });
        } else {
          modelMap.set(key, { ...m, capabilities: { ...m.capabilities } });
        }
      }
    } catch {
      // Ignore individual catalog source failures
    }
  }

  // 3. User-declared overrides (highest priority)
  for (const m of userDeclared) {
    const key = `${m.upstreamProvider}:${m.id}`;
    modelMap.set(key, { ...m, provenance: "user-declared" });
  }

  return Array.from(modelMap.values());
}
