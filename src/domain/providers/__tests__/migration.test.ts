import { describe, it, expect } from "vitest";
import { migrateV1ToV2 } from "../migration.js";

describe("v1 to v2 Provider Config Migration (QS-P4.7)", () => {
  it("migrates legacy inline keys and sets source provenance", () => {
    const v1Config = {
      defaultProvider: "openai",
      openaiApiKey: "sk-openai-legacy-123",
      models: {
        openai: { model: "gpt-4o" },
      },
    };

    const { config, migratedCredentials } = migrateV1ToV2(v1Config);

    expect(config.schemaVersion).toBe(2);
    expect(config.modelAssignments.text?.standard?.providerAccount).toBe("openai");
    expect(config.modelAssignments.text?.standard?.model).toBe("gpt-4o");

    expect(migratedCredentials.length).toBe(1);
    expect(migratedCredentials[0].id).toBe("openai-migrated");
    expect(migratedCredentials[0].keyValue).toBe("sk-openai-legacy-123");
    expect(migratedCredentials[0].source).toBe("disk");

    expect(config.providers.openai.credential).toEqual({
      kind: "seepient",
      id: "openai-migrated",
    });
  });

  it("derives env credential references when no disk key is present", () => {
    const v1Config = {
      defaultProvider: "anthropic",
      models: {
        anthropic: { model: "claude-3-7-sonnet" },
      },
    };

    const { config, migratedCredentials } = migrateV1ToV2(v1Config);

    expect(migratedCredentials.length).toBe(0);
    expect(config.providers.anthropic.credential).toEqual({
      kind: "env",
      name: "ANTHROPIC_API_KEY",
    });
    expect(config.modelAssignments.plan?.standard?.providerAccount).toBe("anthropic");
    expect(config.modelAssignments.plan?.standard?.model).toBe("claude-3-7-sonnet");
  });
});
