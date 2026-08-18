import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ProviderConfigStore } from "../config-store/provider-config-store.js";
import { ProviderRuntime } from "../provider-runtime.js";
import { CompositeCredentialStore } from "../credentials/composite-credential-store.js";
import { runAgentLoop } from "../../agent-loop.js";
import { createHookExecutor } from "../../hooks.js";

describe("Legacy Migration & Env Synthesis E2E", () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...origEnv };
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GLM_API_KEY;
  });

  afterEach(() => {
    process.env = origEnv;
  });

  it("synthesizes default v2 configuration and resolves plan when no overlay exists", async () => {
    process.env.OPENAI_API_KEY = "sk-test-openai-key";

    const configStore = new ProviderConfigStore(":memory:");
    const effective = await configStore.getEffectiveConfig();

    expect(effective.providers.openai).toBeDefined();
    expect(effective.modelAssignments.text.standard).toEqual({
      providerAccount: "openai",
      model: "gpt-4o",
    });

    const credentialStore = new CompositeCredentialStore();
    const runtime = new ProviderRuntime({
      configStore,
      credentialStore,
      adapter: {
        id: "mock-adapter",
        async bind(target) {
          return {
            language: {
              async *stream() {
                yield {
                  type: "content_block_delta",
                  index: 0,
                  delta: { type: "text_delta", text: `Hello from ${target.model}!` },
                };
                yield {
                  type: "finish",
                  stopReason: "end_turn",
                  usage: { inputTokens: 5, outputTokens: 5 },
                };
              },
            },
          } as any;
        },
      },
    });

    const snapshot = await runtime.createTurnSnapshot();
    const plan = await runtime.resolvePlan(snapshot, "text", "standard");
    expect(plan.selectedTarget.providerAccount).toBe("openai");
    expect(plan.selectedTarget.model).toBe("gpt-4o");

    const result = await runAgentLoop({
      provider: {} as any,
      model: "gpt-4o",
      messages: [{ id: "m1", role: "user", content: "hi", timestamp: Date.now() }],
      toolDefs: [],
      maxSteps: 1,
      hooks: createHookExecutor(),
      providerRuntime: runtime,
      turnSnapshot: snapshot,
    });

    expect(result.finishReason).toBe("stop");
    const textStep = result.steps.find((s) => s.type === "text_delta" || s.type === "text");
    expect(textStep?.content).toContain("Hello from gpt-4o!");
  });
});
