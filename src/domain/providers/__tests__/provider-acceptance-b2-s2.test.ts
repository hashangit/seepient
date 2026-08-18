import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { ProviderConfigStore, clearBaseConfigCache } from "../config-store/provider-config-store.js";
import { applyDeepPatch } from "../config-store/deep-patch.js";
import { loadMergedConfig, loadJsonConfig } from "../../../foundations/config.js";
import { SeepientError } from "../../../foundations/errors.js";

describe("Acceptance Tests: B-2, B-3, S-1, S-2", () => {
  let tmpDir: string;
  let overlayPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "seepient-b2s2-test-"));
    overlayPath = path.join(tmpDir, "overlay.json");
    clearBaseConfigCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    clearBaseConfigCache();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("B-2: Environment Variable Projection & Overlay Precedence", () => {
    it("projects LLM_PROVIDER=anthropic and ANTHROPIC_API_KEY into effective config", async () => {
      vi.stubEnv("LLM_PROVIDER", "anthropic");
      vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-api-test-key-123456");

      const store = new ProviderConfigStore(overlayPath);
      const effective = await store.getEffectiveConfig();

      expect(effective.providers["anthropic"]).toBeDefined();
      expect(effective.modelAssignments.text!.standard!.providerAccount).toBe("anthropic");
    });

    it("overlay patch takes precedence over environment variable projection", async () => {
      vi.stubEnv("LLM_PROVIDER", "anthropic");
      vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-api-test-key-123456");

      const store = new ProviderConfigStore(overlayPath);
      await store.updateOverlay(
        {
          modelAssignments: {
            text: {
              standard: {
                providerAccount: "openai",
                model: "gpt-4o",
              },
            },
          },
        },
        0,
      );

      const effective = await store.getEffectiveConfig();
      expect(effective.modelAssignments.text!.standard!.providerAccount).toBe("openai");
      expect(effective.modelAssignments.text!.standard!.model).toBe("gpt-4o");
    });
  });

  describe("B-3: JSON Config Warning & Corruption Handling", () => {
    it("returns warning on corrupted JSON without crashing loadJsonConfig", () => {
      const corruptFile = path.join(tmpDir, "corrupt.json");
      fs.writeFileSync(corruptFile, "{ invalid json content: 123");

      const result = loadJsonConfig(corruptFile);
      expect(result.config).toEqual({});
      expect(result.warning).toContain("Failed to parse config file");
    });

    it("logs warning and loads cleanly when merged config contains invalid JSON", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const configDir = path.join(tmpDir, ".seepient");
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(path.join(configDir, "setting.json"), "NOT_JSON");

      const merged = loadMergedConfig(tmpDir);
      expect(merged).toBeDefined();
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  describe("S-1: TypeBox Runtime Schema Validation", () => {
    it("rejects invalid patch structure with CONFIG_VIOLATION error", () => {
      const store = new ProviderConfigStore(overlayPath);
      expect(() => {
        store.validatePatch({
          retryPolicy: {
            maxAttempts: 99, // Exceeds maximum 5
          },
        });
      }).toThrowError(/ConfigViolation/);
    });

    it("rejects invalid slot patch missing required model property", () => {
      const store = new ProviderConfigStore(overlayPath);
      expect(() => {
        store.validatePatch({
          modelAssignments: {
            text: {
              standard: {
                providerAccount: "openai",
                // missing model
              } as any,
            },
          },
        });
      }).toThrowError(/ConfigViolation/);
    });
  });

  describe("S-2: Atomic Model Assignment Slot Replacement", () => {
    it("completely replaces model assignment slot without merging old fields", () => {
      const baseSlot = {
        providerAccount: "openai",
        model: "gpt-4o",
        thinkingLevel: "high" as const,
        fallback: [{ providerAccount: "anthropic", model: "claude-3-5-sonnet" }],
      };

      const patchSlot = {
        providerAccount: "glm",
        model: "glm-4-plus",
      };

      const result = applyDeepPatch(baseSlot, patchSlot);
      expect(result.providerAccount).toBe("glm");
      expect(result.model).toBe("glm-4-plus");
      expect(result.thinkingLevel).toBeUndefined();
      expect(result.fallback).toBeUndefined();
    });
  });
});
