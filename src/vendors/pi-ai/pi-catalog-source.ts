import { builtinModels, builtinImagesModels } from "@earendil-works/pi-ai/providers/all";
import type { CatalogSource } from "../../foundations/contracts/backend-ports.js";
import type { UpstreamModel } from "../../foundations/schemas/inference.js";

/**
 * Pi AI catalog source mapping models from `@earendil-works/pi-ai` bundled catalog.
 */
export class PiCatalogSource implements CatalogSource {
  async list(): Promise<readonly UpstreamModel[]> {
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
          vision: !!(m as any).inputModalities?.includes("image"),
        },
        provenance: "pi-catalog",
      });
    }

    for (const m of imageModels) {
      // Avoid duplicate if already in chat
      const existing = result.find((r) => r.id === m.id && r.upstreamProvider === m.provider);
      if (existing) {
        existing.capabilities.imageGenerate = true;
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
          provenance: "pi-catalog",
        });
      }
    }

    return result;
  }
}
