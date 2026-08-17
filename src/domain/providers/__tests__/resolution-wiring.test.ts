import { describe, it, expect } from "vitest";
import { ProviderRuntime } from "../provider-runtime.js";
import { MemoryCredentialStore } from "../credentials/memory-credential-store.js";
import { ProviderConfigStore } from "../config-store/provider-config-store.js";

describe("Resolution Sites Wiring (QS-P5.2)", () => {
  it("Site 1-7: resolves through ProviderRuntime.resolvePlan for all purpose/tier pairs", async () => {
    const credStore = new MemoryCredentialStore();
    const configStore = new ProviderConfigStore(":memory:");
    await configStore.updateOverlay({
      providers: {
        "primary-openai": {
          adapter: "pi-ai",
          upstreamProvider: "openai",
          credential: { kind: "none" },
        },
        "backup-anthropic": {
          adapter: "pi-ai",
          upstreamProvider: "anthropic",
          credential: { kind: "none" },
        },
      },
      modelAssignments: {
        text: {
          standard: { providerAccount: "primary-openai", model: "gpt-4o" },
          efficient: { providerAccount: "primary-openai", model: "gpt-4o-mini" },
        },
      },
    }, 0);

    const runtime = new ProviderRuntime({
      configStore,
      credentialStore: credStore,
    });

    const snapshot = await runtime.createTurnSnapshot();

    // Site 1 / CLI bootstrap: text.standard
    const cliPlan = await runtime.resolvePlan(snapshot, "text", "standard");
    expect(cliPlan.selectedTarget.providerAccount).toBe("primary-openai");
    expect(cliPlan.selectedTarget.model).toBe("gpt-4o");

    // Site 2 & 3 / HTTP server generateText/streamText: text.standard
    const httpPlan = await runtime.resolvePlan(snapshot, "text", "standard");
    expect(httpPlan.selectedTarget.model).toBe("gpt-4o");

    // Site 4-7 / SDK per-call overrides
    const sdkPlan = await runtime.resolvePlan(snapshot, "text", "standard", {
      providerAccount: "backup-anthropic",
      model: "claude-3-7-sonnet",
    });
    expect(sdkPlan.selectedTarget.providerAccount).toBe("backup-anthropic");
    expect(sdkPlan.selectedTarget.model).toBe("claude-3-7-sonnet");
  });

  it("Site 8 & 9: skill override resolution produces independent InvocationPlan", async () => {
    const credStore = new MemoryCredentialStore();
    const configStore = new ProviderConfigStore(":memory:");
    await configStore.updateOverlay({
      providers: {
        "openai-main": {
          adapter: "pi-ai",
          upstreamProvider: "openai",
          credential: { kind: "none" },
        },
        "anthropic-specialist": {
          adapter: "pi-ai",
          upstreamProvider: "anthropic",
          credential: { kind: "none" },
        },
      },
      modelAssignments: {
        text: {
          standard: { providerAccount: "openai-main", model: "gpt-4o" },
        },
      },
    }, 0);

    const runtime = new ProviderRuntime({
      configStore,
      credentialStore: credStore,
    });

    const snapshot = await runtime.createTurnSnapshot();

    const turnBasePlan = await runtime.resolvePlan(snapshot, "text", "standard");
    expect(turnBasePlan.selectedTarget.providerAccount).toBe("openai-main");

    const skillOverridePlan = await runtime.resolvePlan(snapshot, "text", "standard", {
      providerAccount: "anthropic-specialist",
      model: "claude-3-5-sonnet",
    });
    expect(skillOverridePlan.selectedTarget.providerAccount).toBe("anthropic-specialist");
    expect(skillOverridePlan.selectedTarget.model).toBe("claude-3-5-sonnet");
  });

  it("handles unconfigured purpose cleanly by throwing UNCONFIGURED_PURPOSE", async () => {
    const runtime = new ProviderRuntime({
      configStore: new ProviderConfigStore(":memory:"),
    });
    const snapshot = await runtime.createTurnSnapshot();
    await expect(
      runtime.resolvePlan(snapshot, "video-generation" as any),
    ).rejects.toThrow(/No model assignment configured for purpose/);
  });
});
