import { describe, it, expect } from "vitest";
import { ProviderRuntime } from "../../providers/provider-runtime.js";
import { ProviderConfigStore } from "../../providers/config-store/provider-config-store.js";
import { MemoryCredentialStore } from "../../providers/credentials/memory-credential-store.js";
import { runAgentLoop } from "../../agent-loop.js";
import { createHookExecutor } from "../../hooks.js";
import { createRuntimeSkillProviderSwitcher } from "../skill-invoker.js";

describe("Skill Runtime Switching (Site #8, P5.4)", () => {
  it("switches target model for skill execution within the same turn snapshot", async () => {
    const executedModels: string[] = [];
    const executedAccounts: string[] = [];

    const configStore = new ProviderConfigStore(":memory:");
    await configStore.updateOverlay({
      providers: {
        openai: { adapter: "pi-ai", upstreamProvider: "openai", credential: { kind: "none" } },
        anthropic: { adapter: "pi-ai", upstreamProvider: "anthropic", credential: { kind: "none" } },
      },
      modelAssignments: {
        text: {
          standard: { providerAccount: "openai", model: "gpt-4o" },
        },
      },
    }, 0);

    const credentialStore = new MemoryCredentialStore();
    const runtime = new ProviderRuntime({
      configStore,
      credentialStore,
      adapter: {
        id: "test-adapter",
        async bind(target) {
          executedModels.push(target.model);
          executedAccounts.push(target.providerAccount);
          return {
            language: {
              async *stream() {
                yield {
                  type: "content_block_delta",
                  index: 0,
                  delta: { type: "text_delta", text: `Response from ${target.model}` },
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
    const switcher = createRuntimeSkillProviderSwitcher(runtime);

    // Step 1: Default turn execution (gpt-4o)
    const result1 = await runAgentLoop({
      provider: {} as any,
      model: "gpt-4o",
      messages: [{ id: "m1", role: "user", content: "hello", timestamp: Date.now() }],
      toolDefs: [],
      maxSteps: 1,
      hooks: createHookExecutor(),
      providerRuntime: runtime,
      turnSnapshot: snapshot,
      providerFactory: switcher as any,
    });

    expect(result1.finishReason).toBe("stop");
    expect(executedModels[0]).toBe("gpt-4o");
    expect(executedAccounts[0]).toBe("openai");

    // Step 2: Skill switch to Claude 3.5 Sonnet on anthropic
    await switcher.switchIfNeeded({
      prompt: "review code",
      skill: { name: "code-review", description: "review code", tags: [] },
      providerSwitchNeeded: true,
      preferredProvider: "anthropic",
      preferredModel: "claude-3-5-sonnet-20241022",
    });

    const result2 = await runAgentLoop({
      provider: {} as any,
      model: "gpt-4o",
      messages: [{ id: "m2", role: "user", content: "review this code", timestamp: Date.now() }],
      toolDefs: [],
      maxSteps: 1,
      hooks: createHookExecutor(),
      providerRuntime: runtime,
      turnSnapshot: snapshot,
      providerFactory: switcher as any,
    });

    expect(result2.finishReason).toBe("stop");
    expect(executedModels[1]).toBe("claude-3-5-sonnet-20241022");
    expect(executedAccounts[1]).toBe("anthropic");

    // Restore switcher and verify target returns to gpt-4o
    switcher.restore();
    const result3 = await runAgentLoop({
      provider: {} as any,
      model: "gpt-4o",
      messages: [{ id: "m3", role: "user", content: "back to normal", timestamp: Date.now() }],
      toolDefs: [],
      maxSteps: 1,
      hooks: createHookExecutor(),
      providerRuntime: runtime,
      turnSnapshot: snapshot,
      providerFactory: switcher as any,
    });

    expect(result3.finishReason).toBe("stop");
    expect(executedModels[2]).toBe("gpt-4o");
    expect(executedAccounts[2]).toBe("openai");
  });
});
