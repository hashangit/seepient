import { describe, it, expect } from "vitest";
import { mergeCatalogs, NATIVE_IMAGE_ANNOTATIONS } from "../catalog-merge.js";
import type { CatalogSource } from "../../../foundations/contracts/backend-ports.js";
import type { UpstreamModel } from "../../../foundations/schemas/inference.js";

describe("Catalog merge (QS-P3.7)", () => {
  it("includes native image annotations by default", async () => {
    const merged = await mergeCatalogs([]);
    expect(merged.length).toBeGreaterThanOrEqual(Object.keys(NATIVE_IMAGE_ANNOTATIONS).length);
    expect(merged.some((m) => m.id === "dall-e-3")).toBe(true);
    expect(merged.some((m) => m.id === "gpt-image-2")).toBe(true);
  });

  it("merges dynamic catalog source with curated models without duplicate IDs", async () => {
    const mockSource: CatalogSource = {
      async list(): Promise<readonly UpstreamModel[]> {
        return [
          {
            id: "gpt-4o",
            upstreamProvider: "openai",
            displayName: "GPT-4o Dynamic",
            contextWindow: 200_000,
            capabilities: {
              toolUse: true,
              streaming: true,
              vision: true,
            },
            provenance: "pi-catalog",
          },
          {
            id: "new-vendor-model",
            upstreamProvider: "vendor-x",
            displayName: "Vendor X Model",
            contextWindow: 64_000,
            capabilities: {
              toolUse: true,
              streaming: true,
              vision: false,
            },
            provenance: "pi-catalog",
          },
        ];
      },
    };

    const merged = await mergeCatalogs([mockSource]);
    const gpt4o = merged.find((m) => m.id === "gpt-4o" && m.upstreamProvider === "openai");
    expect(gpt4o).toBeDefined();
    expect(gpt4o?.contextWindow).toBe(200_000);

    const vendorX = merged.find((m) => m.id === "new-vendor-model");
    expect(vendorX).toBeDefined();
    expect(vendorX?.provenance).toBe("pi-catalog");
  });

  it("prioritizes user-declared models with user-declared provenance", async () => {
    const userDeclared: UpstreamModel[] = [
      {
        id: "gpt-4o",
        upstreamProvider: "openai",
        displayName: "My Custom GPT-4o",
        contextWindow: 500_000,
        capabilities: {
          toolUse: true,
          streaming: true,
          vision: true,
        },
        provenance: "user-declared",
      },
    ];

    const merged = await mergeCatalogs([], userDeclared);
    const gpt4o = merged.find((m) => m.id === "gpt-4o" && m.upstreamProvider === "openai");
    expect(gpt4o?.displayName).toBe("My Custom GPT-4o");
    expect(gpt4o?.contextWindow).toBe(500_000);
    expect(gpt4o?.provenance).toBe("user-declared");
  });
});
