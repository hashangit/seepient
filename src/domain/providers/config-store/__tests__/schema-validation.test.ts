import { describe, it, expect } from "vitest";
import { ProviderConfigStore } from "../provider-config-store.js";
import { SeepientError } from "../../../../foundations/errors.js";

describe("Overlay Schema Validation", () => {
  it("rejects invalid credential kind with ConfigViolation", async () => {
    const store = new ProviderConfigStore(":memory:");
    await expect(
      store.updateOverlay(
        {
          providers: {
            custom: {
              credential: { kind: "invalid-kind" } as any,
            },
          },
        },
        0,
      ),
    ).rejects.toThrow("ConfigViolation");
  });

  it("rejects seepient credential without string id", async () => {
    const store = new ProviderConfigStore(":memory:");
    await expect(
      store.updateOverlay(
        {
          providers: {
            custom: {
              credential: { kind: "seepient", account: "wrong-prop" } as any,
            },
          },
        },
        0,
      ),
    ).rejects.toThrow('requires string property "id"');
  });

  it("accepts valid seepient credential with id", async () => {
    const store = new ProviderConfigStore(":memory:");
    const updated = await store.updateOverlay(
      {
        providers: {
          openai: {
            adapter: "pi-ai",
            upstreamProvider: "openai",
            credential: { kind: "seepient", id: "openai-main" },
          },
        },
      },
      0,
    );
    expect(updated.revision).toBe(1);
    expect((updated.patch.providers as any).openai.credential).toEqual({
      kind: "seepient",
      id: "openai-main",
    });
  });
});
