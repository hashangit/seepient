import type {
  UpstreamModel,
} from "../../foundations/schemas/inference.js";
import type { CatalogSource } from "../../foundations/contracts/backend-ports.js";

function cleanDefined<T extends Record<string, any>>(obj?: T): Partial<T> {
  if (!obj) return {};
  const res: any = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) {
      res[k] = v;
    }
  }
  return res;
}

/**
 * Curated upstream model catalog with baseline capabilities.
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
    supportedReasoningLevels: ["none"],
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
    supportedReasoningLevels: ["none"],
    provenance: "seepient-curated",
  },
  {
    id: "gpt-image-2",
    upstreamProvider: "openai",
    displayName: "GPT Image 2",
    contextWindow: 4096,
    capabilities: {
      toolUse: false,
      streaming: false,
      vision: false,
      imageGenerate: true,
      imageVariation: false,
      imageEdit: true,
      imageMask: true,
      aspectRatios: ["1:1", "16:9", "9:16", "3:2", "2:3", "4:3", "3:4"],
    },
    provenance: "seepient-curated",
  },
  {
    id: "gpt-image-1",
    upstreamProvider: "openai",
    displayName: "GPT Image 1",
    contextWindow: 4096,
    capabilities: {
      toolUse: false,
      streaming: false,
      vision: false,
      imageGenerate: true,
      imageVariation: false,
      imageEdit: true,
      imageMask: true,
      aspectRatios: ["1:1", "16:9", "9:16", "3:2", "2:3", "4:3", "3:4"],
    },
    provenance: "seepient-curated",
  },
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
    id: "claude-3-5-haiku",
    upstreamProvider: "anthropic",
    displayName: "Claude 3.5 Haiku",
    contextWindow: 200_000,
    capabilities: {
      toolUse: true,
      streaming: true,
      vision: true,
    },
    supportedReasoningLevels: ["none"],
    provenance: "seepient-curated",
  },
  {
    id: "gemini-2.5-flash",
    upstreamProvider: "google",
    displayName: "Gemini 2.5 Flash",
    contextWindow: 1_000_000,
    capabilities: {
      toolUse: true,
      streaming: true,
      vision: true,
    },
    supportedReasoningLevels: ["none"],
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
      vision: false,
      imageGenerate: true,
      imageVariation: true,
      imageEdit: true,
      imageMask: true,
      aspectRatios: ["1:1", "16:9", "9:16", "4:3", "3:4"],
    },
    provenance: "seepient-curated",
  },
  {
    id: "glm-4.7",
    upstreamProvider: "glm",
    displayName: "GLM 4.7",
    contextWindow: 128_000,
    capabilities: {
      toolUse: true,
      streaming: true,
      vision: false,
    },
    supportedReasoningLevels: ["none"],
    provenance: "seepient-curated",
  },
];

/**
 * Merges curated models with dynamic catalog sources and user declarations.
 * Prevents undefined properties from overwriting known model capabilities.
 */
export async function mergeCatalogs(
  sources: CatalogSource[],
  userDeclared: UpstreamModel[] = [],
): Promise<UpstreamModel[]> {
  const modelMap = new Map<string, UpstreamModel>();

  // 1. Curated baseline
  for (const m of CURATED_MODELS) {
    modelMap.set(`${m.upstreamProvider}:${m.id}`, { ...m, capabilities: { ...m.capabilities } });
  }

  // 2. Dynamic vendor sources (e.g. Pi bundled catalog)
  for (const source of sources) {
    try {
      const models = await source.list();
      for (const m of models) {
        const key = `${m.upstreamProvider}:${m.id}`;
        const existing = modelMap.get(key);
        if (existing) {
          const cleanM = cleanDefined(m);
          const cleanCaps = cleanDefined(m.capabilities);
          modelMap.set(key, {
            ...existing,
            ...cleanM,
            capabilities: {
              ...existing.capabilities,
              ...cleanCaps,
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

  // 3. User-declared overrides (merge without wiping capabilities)
  for (const m of userDeclared) {
    const key = `${m.upstreamProvider}:${m.id}`;
    const existing = modelMap.get(key);
    if (existing) {
      const cleanM = cleanDefined(m);
      const cleanCaps = cleanDefined(m.capabilities);
      modelMap.set(key, {
        ...existing,
        ...cleanM,
        capabilities: {
          ...existing.capabilities,
          ...cleanCaps,
        },
        provenance: "user-declared",
      });
    } else {
      modelMap.set(key, { ...m, provenance: "user-declared" });
    }
  }

  return Array.from(modelMap.values());
}
