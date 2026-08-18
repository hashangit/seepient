/**
 * Secondary Catalog Source: Oh-My-Pi (OMP) Catalog Enricher
 *
 * Implements R-10 / D-CAT-2:
 * Lazy, secondary metadata enrichment source.
 * pi-ai is the base and runtime truth. OMP only fills missing fields
 * (e.g. zero/missing pricing, missing reasoning levels, missing contextWindow).
 */

import type { CatalogSource } from "../../foundations/contracts/backend-ports.js";
import type { UpstreamModel, Pricing, ThinkingLevel } from "../../foundations/schemas/inference.js";

export class OmpCatalogSource implements CatalogSource {
  readonly id = "omp-catalog";

  private dataPromise: Promise<Record<string, any> | undefined> | undefined;

  private async loadOmpData(): Promise<Record<string, any> | undefined> {
    if (!this.dataPromise) {
      this.dataPromise = (async () => {
        try {
          // Dynamic import so the large data file is never evaluated at startup
          // @ts-ignore
          const mod = await import("@oh-my-pi/pi-catalog").catch(() => undefined);
          return mod?.catalog || mod?.default || undefined;
        } catch {
          return undefined;
        }
      })();
    }
    return this.dataPromise;
  }

  async list(): Promise<readonly UpstreamModel[]> {
    // OMP is an enrichment source, not a primary model publisher.
    return [];
  }

  /**
   * Deterministically enriches existing base models from pi-ai with OMP metadata.
   * pi-ai fields are NEVER overwritten when present and valid.
   */
  async enrichModels(baseModels: UpstreamModel[]): Promise<UpstreamModel[]> {
    const ompData = await this.loadOmpData();
    if (!ompData) return baseModels;

    return baseModels.map((model) => {
      const ompEntry = ompData[`${model.upstreamProvider}/${model.id}`] || ompData[model.id];
      if (!ompEntry) return model;

      let pricing = model.pricing;
      if (
        (!pricing || (pricing.promptPerMillion === 0 && pricing.completionPerMillion === 0)) &&
        ompEntry.pricing
      ) {
        pricing = {
          promptPerMillion: ompEntry.pricing.promptPerMillion ?? pricing?.promptPerMillion,
          completionPerMillion: ompEntry.pricing.completionPerMillion ?? pricing?.completionPerMillion,
          cachedPromptPerMillion: ompEntry.pricing.cachedPromptPerMillion ?? pricing?.cachedPromptPerMillion,
          cacheWritePerMillion: ompEntry.pricing.cacheWritePerMillion ?? pricing?.cacheWritePerMillion,
          reasoningPerMillion: ompEntry.pricing.reasoningPerMillion ?? pricing?.reasoningPerMillion,
        };
      }

      let supportedReasoningLevels = model.supportedReasoningLevels;
      if (
        (!supportedReasoningLevels || supportedReasoningLevels.length === 0) &&
        Array.isArray(ompEntry.supportedReasoningLevels)
      ) {
        supportedReasoningLevels = ompEntry.supportedReasoningLevels;
      }

      let contextWindow = model.contextWindow;
      if ((!contextWindow || contextWindow <= 0) && ompEntry.contextWindow) {
        contextWindow = ompEntry.contextWindow;
      }

      return {
        ...model,
        pricing,
        supportedReasoningLevels,
        contextWindow,
      };
    });
  }
}
