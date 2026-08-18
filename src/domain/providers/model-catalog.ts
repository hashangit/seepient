import type {
  UpstreamModel,
} from "../../foundations/schemas/inference.js";
import type { ProviderEffectiveConfig } from "../../foundations/schemas/provider-config.js";
import type { CatalogSource } from "../../foundations/contracts/backend-ports.js";
import { mergeCatalogs } from "../../capabilities/inference/catalog-merge.js";
import { DiscoveryCache } from "./discovery-cache.js";

import { PiCatalogSource } from "../../vendors/pi-ai/pi-catalog-source.js";

export interface AvailableModel extends UpstreamModel {
  reachableVia: string[]; // configured account IDs that can reach this model
}

/**
 * ModelCatalog aggregating curated, dynamic, user-declared, and auto-discovered models.
 */
export class ModelCatalog {
  private sources: CatalogSource[];
  private discoveryCache: DiscoveryCache;

  constructor(sources?: CatalogSource[], discoveryCache?: DiscoveryCache) {
    this.sources = sources ?? [new PiCatalogSource()];
    this.discoveryCache = discoveryCache ?? new DiscoveryCache();
  }

  getDiscoveryCache(): DiscoveryCache {
    return this.discoveryCache;
  }

  /**
   * Returns the consolidated list of all known upstream models.
   */
  async getAllModels(userDeclared: UpstreamModel[] = []): Promise<UpstreamModel[]> {
    const baseModels = await mergeCatalogs(this.sources, userDeclared);
    const modelMap = new Map<string, UpstreamModel>();

    for (const m of baseModels) {
      modelMap.set(`${m.upstreamProvider}:${m.id}`, m);
    }

    // Add discovered models from cache
    for (const record of this.discoveryCache.list()) {
      const provider = record.upstreamProvider || record.account;
      for (const modelId of record.modelIds) {
        const key = `${provider}:${modelId}`;
        if (!modelMap.has(key)) {
          modelMap.set(key, {
            id: modelId,
            upstreamProvider: provider,
            displayName: modelId,
            contextWindow: 128_000,
            capabilities: {
              toolUse: true,
              streaming: true,
              vision: false,
            },
            supportedReasoningLevels: ["none"],
            provenance: "provider-discovered",
          });
        }
      }
    }

    return Array.from(modelMap.values());
  }

  /**
   * Projects AvailableModels showing reachableVia accounts for each model.
   */
  async listAvailableModels(
    config: ProviderEffectiveConfig,
  ): Promise<AvailableModel[]> {
    const userDeclared = extractUserDeclaredModels(config);
    const accounts = config.providers || {};

    const allModels = await this.getAllModels(userDeclared);
    const availableList: AvailableModel[] = [];

    for (const model of allModels) {
      const reachableVia: string[] = [];

      for (const [accId, entry] of Object.entries(accounts)) {
        if (
          entry.upstreamProvider === model.upstreamProvider ||
          accId === model.upstreamProvider
        ) {
          reachableVia.push(accId);
        }
      }

      availableList.push({
        ...model,
        reachableVia,
      });
    }

    return availableList;
  }
}

/**
 * Extracts user-declared models from ProviderEffectiveConfig.providers.
 * Properly parses the Record<string, UserDeclaredModel> schema shape.
 */
export function extractUserDeclaredModels(config: ProviderEffectiveConfig): UpstreamModel[] {
  const userDeclared: UpstreamModel[] = [];
  const accounts = config.providers || {};

  for (const [accId, entry] of Object.entries(accounts)) {
    if (entry && entry.models && typeof entry.models === "object" && !Array.isArray(entry.models)) {
      for (const [modelId, declared] of Object.entries(entry.models)) {
        userDeclared.push({
          id: modelId,
          upstreamProvider: entry.upstreamProvider || accId,
          displayName: declared.displayName || modelId,
          contextWindow: declared.contextWindow || 128_000,
          capabilities: {
            toolUse: declared.capabilities?.toolUse ?? true,
            streaming: declared.capabilities?.streaming ?? true,
            vision: declared.capabilities?.vision ?? false,
            imageGenerate: declared.capabilities?.imageGenerate,
            imageVariation: declared.capabilities?.imageVariation,
            imageEdit: declared.capabilities?.imageEdit,
            imageMask: declared.capabilities?.imageMask,
            aspectRatios: declared.capabilities?.aspectRatios,
          },
          supportedReasoningLevels: declared.supportedReasoningLevels,
          provenance: "user-declared",
        });
      }
    }
  }

  return userDeclared;
}
