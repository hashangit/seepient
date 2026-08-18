import { describe, it, expect } from "vitest";
import { applyDeepPatch, mergePatches } from "../deep-patch.js";

describe("Deep Patch & Prototype Pollution Protection", () => {
  it("merges nested objects and deletes keys set to null", () => {
    const target = {
      providers: {
        openai: { model: "gpt-4o", apiKey: "secret" },
        anthropic: { model: "claude-3-7-sonnet" },
      },
      retryPolicy: { maxAttempts: 3 },
    };

    const patch = {
      providers: {
        openai: { model: "gpt-4o-mini" },
        anthropic: null,
      },
      retryPolicy: { maxAttempts: 5 },
    };

    const result = applyDeepPatch(target, patch);
    expect(result.providers.openai.model).toBe("gpt-4o-mini");
    expect(result.providers.openai.apiKey).toBe("secret");
    expect(result.providers.anthropic).toBeUndefined();
    expect(result.retryPolicy.maxAttempts).toBe(5);
  });

  it("blocks prototype pollution attacks on applyDeepPatch", () => {
    const payload = JSON.parse('{"__proto__": {"polluted": true}, "constructor": {"prototype": {"polluted": true}}}');
    const target = {};

    const result = applyDeepPatch(target, payload);
    expect(result.polluted).toBeUndefined();
    expect(({} as any).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(result, "__proto__")).toBe(false);
  });

  it("blocks prototype pollution attacks on mergePatches", () => {
    const payload = JSON.parse('{"__proto__": {"polluted": true}}');
    const basePatch = { providers: { openai: { model: "gpt-4o" } } };

    const merged = mergePatches(basePatch, payload);
    expect(({} as any).polluted).toBeUndefined();
    expect(merged.providers.openai.model).toBe("gpt-4o");
  });
});
