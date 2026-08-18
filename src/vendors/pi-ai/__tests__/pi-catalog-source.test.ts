import { describe, it, expect } from "vitest";
import { PiCatalogSource } from "../pi-catalog-source.js";

describe("WS1 (R-1, R-2): PiCatalogSource in @earendil-works/pi-ai 0.84.2", () => {
  it("loads models from Pi catalog and maps pricing, reasoning, and capabilities accurately", async () => {
    const source = new PiCatalogSource();
    const models = await source.list();

    expect(models.length).toBeGreaterThan(1200);

    // Assert key models exist in the 0.84.2 catalog
    const terra = models.find((m) => m.id.includes("gpt-5.6-terra") || m.id === "gpt-5.6-terra");
    const sonnet = models.find((m) => m.id.includes("claude-sonnet-5") || m.id === "claude-sonnet-5");
    const glm53 = models.find((m) => m.id.includes("glm-5.3"));
    const gemini37 = models.find((m) => m.id.includes("gemini-3.7-flash"));

    expect(terra).toBeDefined();
    expect(sonnet).toBeDefined();
    expect(glm53).toBeDefined();
    expect(gemini37).toBeDefined();

    // Verify priced model carries pricing incl. cachedPromptPerMillion
    const pricedSample = models.find((m) => m.pricing && m.pricing.promptPerMillion && m.pricing.cachedPromptPerMillion);
    expect(pricedSample).toBeDefined();
    expect(pricedSample?.pricing?.promptPerMillion).toBeGreaterThan(0);

    // Verify unpriced / zero-priced model (e.g. zai/glm-5.3 with all 0s in pi-ai) has undefined pricing per never-0 contract
    const unpricedModel = models.find((m) => m.id === "glm-5.3" && m.upstreamProvider === "zai");
    if (unpricedModel) {
      expect(unpricedModel.pricing).toBeUndefined();
    }

    // Verify no supportedReasoningLevels contains "off"
    for (const m of models) {
      if (m.supportedReasoningLevels) {
        expect(m.supportedReasoningLevels).not.toContain("off");
      }
    }
  });
});
