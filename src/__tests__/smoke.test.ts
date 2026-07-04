import { describe, it, expect } from "vitest";

describe("Seepient smoke test — module resolution", () => {
  it("SDK public surface imports without error", async () => {
    const sdk = await import("../adapters/sdk/index.js");
    expect(typeof sdk.generateText).toBe("function");
    expect(typeof sdk.streamText).toBe("function");
    expect(typeof sdk.createAgent).toBe("function");
    expect(typeof sdk.settings).toBe("object");
    expect(typeof sdk.compose).toBe("function");
  });

  it("core modules import without error", async () => {
    const { runAgentLoop } = await import("../core/agent-loop.js");
    const { createHookExecutor } = await import("../core/hooks.js");
    const { SeepientError } = await import("../core/errors.js");
    const { StreamManager } = await import("../core/stream-manager.js");

    expect(typeof runAgentLoop).toBe("function");
    expect(typeof createHookExecutor).toBe("function");
    expect(SeepientError).toBeDefined();
    expect(typeof StreamManager).toBe("function");
  });

  it("provider modules import without error", async () => {
    const { getProvider, configureProviders } = await import("../core/provider-resolver.js");
    const { createProvider } = await import("../providers/factory.js");

    expect(typeof getProvider).toBe("function");
    expect(typeof configureProviders).toBe("function");
    expect(typeof createProvider).toBe("function");
  });

  it("tool executor imports without error", async () => {
    const { resolveTools } = await import("../core/tool-executor.js");
    expect(typeof resolveTools).toBe("function");
  });

  it("skill modules import without error", async () => {
    const { parseFrontmatter } = await import("../skills/parser.js");
    const { parseInvocation, substituteArgs } = await import("../skills/args.js");
    expect(typeof parseFrontmatter).toBe("function");
    expect(typeof parseInvocation).toBe("function");
    expect(typeof substituteArgs).toBe("function");
  });
});
