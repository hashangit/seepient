import { describe, it, expect } from "vitest";
import { migrateV1ToV2 } from "../migration.js";
import type { AppConfig } from "../../../foundations/config.js";

describe("v1 to v2 Provider Config Migration (QS-P4.7)", () => {
  it("migrates real AppConfig top-level apiKey and assigns to default provider", () => {
    const v1Config: AppConfig = {
      provider: "openai",
      apiKey: "sk-openai-top-level",
      model: "gpt-4o",
    };

    const { config, migratedCredentials } = migrateV1ToV2(v1Config);

    expect(config.schemaVersion).toBe(2);
    expect(config.modelAssignments.text?.standard?.providerAccount).toBe("openai");
    expect(config.modelAssignments.text?.standard?.model).toBe("gpt-4o");

    expect(migratedCredentials.length).toBe(1);
    expect(migratedCredentials[0].id).toBe("openai-migrated");
    expect(migratedCredentials[0].keyValue).toBe("sk-openai-top-level");
    expect(migratedCredentials[0].source).toBe("disk");

    expect(config.providers.openai.credential).toEqual({
      kind: "seepient",
      id: "openai-migrated",
    });
  });

  it("migrates nested models map keys and custom baseUrls", () => {
    const v1Config: AppConfig = {
      provider: "openai-compatible",
      models: {
        "openai-compatible": {
          apiKey: "sk-compat-123",
          baseUrl: "http://localhost:11434/v1",
          model: "llama3.3:70b",
        },
      },
      imageApiKey: "sk-image-key",
      imageModel: "dall-e-3",
    };

    const { config, migratedCredentials } = migrateV1ToV2(v1Config);

    expect(config.modelAssignments.plan?.standard?.providerAccount).toBe("openai-compatible");
    expect(config.modelAssignments.plan?.standard?.model).toBe("llama3.3:70b");
    expect(config.providers["openai-compatible"].baseUrl).toBe("http://localhost:11434/v1");

    // Dedicated image account migrated
    expect(config.providers["image-openai"]).toBeDefined();
    expect(config.modelAssignments.media?.image?.providerAccount).toBe("image-openai");
    expect(migratedCredentials.some((c) => c.id === "openai-image-migrated")).toBe(true);
  });

  it("derives env credential references when no disk key is present and chooses provider-appropriate model", () => {
    const v1Config: AppConfig = {
      provider: "anthropic",
    };

    const res = migrateV1ToV2(v1Config, { dryRun: true });
    expect(res.dryRun).toBe(true);
    expect(res.migratedCredentials.length).toBe(0);
    expect(res.config.providers.anthropic.credential).toEqual({
      kind: "env",
      name: "ANTHROPIC_API_KEY",
    });
    expect(res.config.modelAssignments.plan?.standard?.providerAccount).toBe("anthropic");
    expect(res.config.modelAssignments.plan?.standard?.model).toBe("claude-sonnet-5");
  });
});
