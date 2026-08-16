import { builtinModels, builtinImagesModels } from "@earendil-works/pi-ai/providers/all";
import type {
  DiscoverySource,
  ProviderAccountContext,
} from "../../foundations/contracts/backend-ports.js";

/**
 * Pi AI model discovery source returning model IDs from the bundled catalog.
 * Failure-safe: never throws errors to callers.
 */
export class PiDiscoverySource implements DiscoverySource {
  async discover(account: ProviderAccountContext): Promise<readonly string[]> {
    try {
      const provider = account.upstreamProvider === "glm" ? "zai" : account.upstreamProvider;
      const chatModels = builtinModels()
        .getModels(provider)
        .map((m) => m.id);
      const imgModels = builtinImagesModels()
        .getModels(provider)
        .map((m) => m.id);

      const uniqueIds = Array.from(new Set([...chatModels, ...imgModels]));
      return uniqueIds;
    } catch {
      return [];
    }
  }
}
