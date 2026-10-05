import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type {
  DiscoverySource,
  DiscoveryResult,
  ProviderAccountContext,
} from "../../foundations/contracts/backend-ports.js";

/**
 * Pi AI model discovery source returning model IDs from the catalog.
 * Failure-safe: never throws errors to callers.
 */
export class PiDiscoverySource implements DiscoverySource {
  private static cachedModels = builtinModels();

  async discover(account: ProviderAccountContext): Promise<DiscoveryResult> {
    try {
      const provider = account.upstreamProvider === "glm" ? "zai" : account.upstreamProvider;
      const chatModels = PiDiscoverySource.cachedModels
        .getModels(provider)
        .map((m) => m.id);
      const imgModels = PiDiscoverySource.cachedModels
        .getModelsOfType("image", provider)
        .map((m) => m.id);

      const uniqueIds = Array.from(new Set([...chatModels, ...imgModels]));
      return { modelIds: uniqueIds };
    } catch (err: any) {
      return { modelIds: [], error: err?.message || "Failed to discover Pi models" };
    }
  }
}
