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
 * Seepient-native image annotations for specialized image drivers.
 */
export const NATIVE_IMAGE_ANNOTATIONS: Record<string, Partial<UpstreamModel>> = {
  "gpt-image-2": {
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
    supportedReasoningLevels: ["none"],
    provenance: "seepient-curated",
  },
  "gpt-image-1": {
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
    supportedReasoningLevels: ["none"],
    provenance: "seepient-curated",
  },
  "dall-e-3": {
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
    supportedReasoningLevels: ["none"],
    provenance: "seepient-curated",
  },
  "dall-e-2": {
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
    supportedReasoningLevels: ["none"],
    provenance: "seepient-curated",
  },
  "gemini-3.1-flash-image": {
    upstreamProvider: "google",
    displayName: "Gemini 3.1 Flash Image",
    contextWindow: 32_000,
    capabilities: {
      toolUse: false,
      streaming: false,
      vision: false,
      imageGenerate: true,
      imageVariation: false,
      imageEdit: true,
      imageMask: true,
      aspectRatios: ["1:1", "16:9", "9:16", "4:3", "3:4"],
    },
    supportedReasoningLevels: ["none"],
    provenance: "seepient-curated",
  },
};

/**
 * Merges dynamic catalog sources (such as Pi bundled catalog) with native image driver annotations
 * and user declarations.
 */
export async function mergeCatalogs(
  sources: CatalogSource[],
  userDeclared: UpstreamModel[] = [],
): Promise<UpstreamModel[]> {
  const modelMap = new Map<string, UpstreamModel>();

  // 1. Ingest full, authoritative upstream models dynamically from sources
  for (const source of sources) {
    try {
      const models = await source.list();
      for (const m of models) {
        const key = `${m.upstreamProvider}:${m.id}`;
        const existing = modelMap.get(key);
        const annotation = NATIVE_IMAGE_ANNOTATIONS[m.id];
        const base = annotation
          ? {
              ...m,
              ...cleanDefined(annotation),
              capabilities: {
                ...m.capabilities,
                ...cleanDefined(annotation.capabilities),
              },
            }
          : m;

        if (existing) {
          const cleanM = cleanDefined(base);
          const cleanCaps = cleanDefined(base.capabilities);
          modelMap.set(key, {
            ...existing,
            ...cleanM,
            capabilities: {
              ...existing.capabilities,
              ...cleanCaps,
            },
          });
        } else {
          modelMap.set(key, { ...base, capabilities: { ...base.capabilities } });
        }
      }
    } catch {
      // Ignore individual catalog source failures
    }
  }

  // 2. Ensure native image models are present if not already emitted by sources
  for (const [id, annotation] of Object.entries(NATIVE_IMAGE_ANNOTATIONS)) {
    const provider = annotation.upstreamProvider || "openai";
    const key = `${provider}:${id}`;
    if (!modelMap.has(key)) {
      modelMap.set(key, {
        id,
        upstreamProvider: provider,
        displayName: annotation.displayName || id,
        contextWindow: annotation.contextWindow ?? 4096,
        capabilities: {
          toolUse: false,
          streaming: false,
          vision: false,
          imageGenerate: true,
          ...annotation.capabilities,
        },
        supportedReasoningLevels: annotation.supportedReasoningLevels ?? ["none"],
        provenance: "seepient-curated",
      });
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
