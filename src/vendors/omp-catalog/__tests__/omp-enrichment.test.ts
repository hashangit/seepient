import { describe, it, expect } from "vitest";
import { OmpCatalogSource } from "../omp-catalog-source.js";
import type { UpstreamModel } from "../../../foundations/schemas/inference.js";

describe("WS9: OMP Secondary Catalog Enrichment (R-10)", () => {
  it("preserves pi-ai base fields and never overwrites non-zero pricing", async () => {
    const source = new OmpCatalogSource();
    const baseModels: UpstreamModel[] = [
      {
        id: "gpt-4o",
        upstreamProvider: "openai",
        displayName: "GPT-4o",
        contextWindow: 128_000,
        capabilities: { toolUse: true, streaming: true, vision: true },
        pricing: { promptPerMillion: 2.5, completionPerMillion: 10 },
        supportedReasoningLevels: ["none"],
        provenance: "pi-catalog",
      },
    ];

    const enriched = await source.enrichModels(baseModels);
    expect(enriched[0].id).toBe("gpt-4o");
    expect(enriched[0].pricing?.promptPerMillion).toBe(2.5);
    expect(enriched[0].contextWindow).toBe(128_000);
  });

  it("handles missing OMP module gracefully without throwing", async () => {
    const source = new OmpCatalogSource();
    const baseModels: UpstreamModel[] = [
      {
        id: "glm-5.3",
        upstreamProvider: "glm",
        displayName: "GLM 5.3",
        contextWindow: 128_000,
        capabilities: { toolUse: true, streaming: true, vision: false },
        supportedReasoningLevels: ["none"],
        provenance: "pi-catalog",
      },
    ];

    const enriched = await source.enrichModels(baseModels);
    expect(enriched).toHaveLength(1);
    expect(enriched[0].id).toBe("glm-5.3");
  });
});
