import { describe, it, expect } from "vitest";
import { ProviderConfigStore } from "../../domain/providers/config-store/provider-config-store.js";
import { MemoryCredentialStore } from "../../domain/providers/credentials/memory-credential-store.js";
import { ProviderRuntime } from "../../domain/providers/provider-runtime.js";
import { AggregateInferenceAdapter } from "../../capabilities/inference/aggregate-adapter.js";
import { createSeepient } from "../sdk/seepient.js";
import type { TurnSnapshot } from "../../domain/providers/assignment-resolver.js";

describe("Surface Parity Suite (QS-P6.7)", () => {
  it("resolves identical plan given identical snapshot and override across SDK, Runtime, and Store", async () => {
    const configStore = new ProviderConfigStore(":memory:");
    await configStore.updateOverlay(
      {
        providers: {
          openai: { adapter: "pi-ai", upstreamProvider: "openai", credential: { kind: "none" } },
          anthropic: { adapter: "pi-ai", upstreamProvider: "anthropic", credential: { kind: "none" } },
        },
        modelAssignments: {
          text: {
            standard: { providerAccount: "openai", model: "o3-mini" },
            complex: { providerAccount: "anthropic", model: "claude-3-7-sonnet" },
          },
        },
      },
      0,
    );

    const credStore = new MemoryCredentialStore();
    const runtime = new ProviderRuntime({
      configStore,
      credentialStore: credStore,
      adapter: new AggregateInferenceAdapter({}),
    });

    const snapshot: TurnSnapshot = await runtime.createTurnSnapshot();

    // 1. Direct runtime resolution
    const runtimePlan = await runtime.resolvePlan(snapshot, "text", "standard", {
      thinkingLevel: "high",
    });

    // 2. SDK instance resolution
    const sdk = await createSeepient({
      providers: snapshot.config.providers,
      modelAssignments: snapshot.assignments,
      credentials: credStore,
    });
    const sdkResolved = await sdk.resolve({
      purpose: "text",
      tier: "standard",
      override: { thinkingLevel: "high" },
    });

    // Parity assertion
    expect(runtimePlan.selectedTarget.providerAccount).toBe(sdkResolved.providerAccount);
    expect(runtimePlan.selectedTarget.model).toBe(sdkResolved.model.id);
    expect(runtimePlan.selectedTarget.thinkingLevel).toBe(sdkResolved.thinkingLevel);
    expect(runtimePlan.selectedTarget.model).toBe("o3-mini");
    expect(runtimePlan.selectedTarget.thinkingLevel).toBe("high");
  });
});
