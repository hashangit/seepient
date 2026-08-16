import type {
  UpstreamModel,
} from "../../foundations/schemas/inference.js";
import type { ProviderEffectiveConfig } from "../../foundations/schemas/provider-config.js";
import type { CatalogSource } from "../../foundations/contracts/backend-ports.js";
import { CURATED_MODELS, mergeCatalogs } from "../../capabilities/inference/catalog-merge.js";
import { DiscoveryCache } from "./discovery-cache.js";

export interface AvailableModel extends UpstreamModel {
  reachableVia: string[]; // configured account IDs that can reach this model
}

/**
 * ModelCatalog aggregating curated, dynamic, user-declared, and auto-discovered models.
 */
export class ModelCatalog {
  private sources: CatalogSource[];
  private discoveryCache: DiscoveryCache;

  constructor(sources: CatalogSource[] = [], discoveryCache?: DiscoveryCache) {
    this.sources = sources;
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
      for (const modelId of record.modelIds) {
        // Look up provider from account or default
        const key = `${record.account}:${modelId}`;
        if (!modelMap.has(key)) {
          modelMap.set(key, {
            id: modelId,
            upstreamProvider: record.account,
            displayName: modelId,
            contextWindow: 128_000,
            capabilities: {
              toolUse: true,
              streaming: true,
              vision: false,
            },
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
    // Extract user-declared models from config.providers
    const userDeclared: UpstreamModel[] = [];
    const accounts = config.providers || {};

    for (const [accId, entry] of Object.entries(accounts)) {
      if (entry.models) {
        for (const [modelId, declared] of Object.entries(entry.models)) {
          userDeclared.push({
            id: modelId,
            upstreamProvider: entry.upstreamProvider,
            displayName: declared.displayName || modelId,
            contextWindow: declared.contextWindow || 128_000,
            capabilities: {
              toolUse: declared.capabilities.toolUse ?? true,
              streaming: declared.capabilities.streaming ?? true,
              vision: declared.capabilities.vision ?? false,
              imageGenerate: declared.capabilities.imageGenerate,
              imageVariation: declared.capabilities.imageVariation,
              imageEdit: declared.capabilities.imageEdit,
              imageMask: declared.capabilities.imageMask,
              aspectRatios: declared.capabilities.aspectRatios,
            },
            supportedReasoningLevels: declared.supportedReasoningLevels,
            provenance: "user-declared",
          });
        }
      }
    }

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
