import { builtinModels, builtinImagesModels } from "@earendil-works/pi-ai/providers/all";
import type { CatalogSource } from "../../foundations/contracts/backend-ports.js";
import type { UpstreamModel, Pricing, ThinkingLevel } from "../../foundations/schemas/inference.js";
import { registerCatalogAccessor } from "../../foundations/models-catalog.js";

function mapPricing(cost?: any): Pricing | undefined {
  if (!cost) return undefined;
  const input = typeof cost.input === "number" && cost.input > 0 ? cost.input : undefined;
  const output = typeof cost.output === "number" && cost.output > 0 ? cost.output : undefined;
  const cacheRead = typeof cost.cacheRead === "number" && cost.cacheRead > 0 ? cost.cacheRead : undefined;
  const cacheWrite = typeof cost.cacheWrite === "number" && cost.cacheWrite > 0 ? cost.cacheWrite : undefined;

  // Prune all-zero cost to undefined (contract: unknown pricing is absent, never 0)
  if (input === undefined && output === undefined && cacheRead === undefined && cacheWrite === undefined) {
    return undefined;
  }

  return {
    promptPerMillion: input,
    completionPerMillion: output,
    cachedPromptPerMillion: cacheRead,
    cacheWritePerMillion: cacheWrite,
  };
}

function mapThinkingLevels(m: any): ThinkingLevel[] {
  if (m.thinkingLevelMap && typeof m.thinkingLevelMap === "object") {
    const levels: ThinkingLevel[] = [];
    for (const [key, val] of Object.entries(m.thinkingLevelMap)) {
      if (val !== null && val !== undefined) {
        const mapped = key === "off" ? "none" : (key as ThinkingLevel);
        if (!levels.includes(mapped)) {
          levels.push(mapped);
        }
      }
    }
    if (levels.length > 0) {
      return levels;
    }
  }

  if (m.reasoning === true) {
    return ["none", "low", "medium", "high"];
  }

  return ["none"];
}

let cachedSyncCatalog: UpstreamModel[] | null = null;

export function getSyncBuiltinCatalog(): UpstreamModel[] {
  if (cachedSyncCatalog) {
    return cachedSyncCatalog;
  }

  const chatModels = builtinModels().getModels();
  const imageModels = builtinImagesModels().getModels();
  const result: UpstreamModel[] = [];

  for (const m of chatModels) {
    result.push({
      id: m.id,
      upstreamProvider: m.provider || "openrouter",
      displayName: (m as any).name || m.id,
      contextWindow: m.contextWindow ?? 128_000,
      capabilities: {
        toolUse: true,
        streaming: true,
        vision: !!((m as any).input?.includes("image") || (m as any).inputModalities?.includes("image")),
      },
      supportedReasoningLevels: mapThinkingLevels(m),
      pricing: mapPricing(m.cost),
      provenance: "pi-catalog",
    });
  }

  for (const m of imageModels) {
    const existing = result.find((r) => r.id === m.id && r.upstreamProvider === m.provider);
    if (existing) {
      existing.capabilities.imageGenerate = true;
      if (!existing.pricing) {
        existing.pricing = mapPricing(m.cost);
      }
    } else {
      result.push({
        id: m.id,
        upstreamProvider: m.provider || "openrouter",
        displayName: (m as any).name || m.id,
        contextWindow: (m as any).contextWindow ?? 32_000,
        capabilities: {
          toolUse: false,
          streaming: false,
          vision: true,
          imageGenerate: true,
        },
        pricing: mapPricing(m.cost),
        provenance: "pi-catalog",
      });
    }
  }

  cachedSyncCatalog = result;
  return cachedSyncCatalog;
}

// Auto-register with foundations catalog accessor
registerCatalogAccessor(getSyncBuiltinCatalog);

/**
 * Pi AI catalog source mapping models from `@earendil-works/pi-ai` bundled catalog.
 */
export class PiCatalogSource implements CatalogSource {
  async list(): Promise<readonly UpstreamModel[]> {
    return getSyncBuiltinCatalog();
  }
}
