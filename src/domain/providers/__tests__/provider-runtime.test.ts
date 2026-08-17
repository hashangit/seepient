import { describe, it, expect } from "vitest";
import { ProviderRuntime } from "../provider-runtime.js";
import { MemoryCredentialStore } from "../credentials/memory-credential-store.js";
import { AggregateInferenceAdapter } from "../../../capabilities/inference/aggregate-adapter.js";
import type {
  LanguageBackend,
  ImageBackend,
  InferenceTarget,
  LanguageRequest,
} from "../../../foundations/contracts/backend-ports.js";
import type { StreamEvent } from "../../../foundations/schemas/inference.js";
import { InferenceError } from "../../../foundations/errors.js";

import { ProviderConfigStore } from "../config-store/provider-config-store.js";

describe("ProviderRuntime (QS-P4.6)", () => {
  it("pins an immutable TurnSnapshot for the turn duration", async () => {
    const runtime = new ProviderRuntime({
      configStore: new ProviderConfigStore(":memory:"),
    });
    const snap1 = await runtime.createTurnSnapshot();
    expect(snap1.revision).toBe(0);

    // Mutation does not alter existing snapshot
    await runtime.configStore.updateOverlay(
      {
        providers: {
          "test-acc": {
            adapter: "pi-ai",
            upstreamProvider: "openai",
            credential: { kind: "none" },
          } as any,
        },
      },
      0,
    );

    const snap2 = await runtime.createTurnSnapshot();
    expect(snap2.revision).toBe(1);
    expect(snap1.revision).toBe(0);
  });

  it("drives multi-target fallback execution on language stream failures", async () => {
    let target1Calls = 0;
    let target2Calls = 0;

    const mockLangBackend: LanguageBackend = {
      chatStream: async function* (target: InferenceTarget) {
        if (target.providerAccount === "primary") {
          target1Calls++;
          throw new InferenceError({
            code: "rate_limit",
            message: "429 Primary rate limited",
            providerAccount: target.providerAccount,
            model: target.model,
            retryable: true,
          });
        }

        target2Calls++;
        yield { type: "start", resolvedModel: { modelId: target.model, providerAccount: target.providerAccount } };
        yield { type: "content_block_start", index: 0, block: { type: "text", text: "" } };
        yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Fallback response" } };
        yield { type: "content_block_stop", index: 0 };
        yield { type: "finish", stopReason: "end_turn", usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 } };
      },
      chat: async () => ({
        message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
        stopReason: "end_turn",
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      }),
    };

    const adapter = new AggregateInferenceAdapter({
      language: mockLangBackend,
    });

    const credStore = new MemoryCredentialStore();
    const runtime = new ProviderRuntime({
      adapter,
      credentialStore: credStore,
    });

    const cred = await credStore.resolve({ kind: "none" });

    const plan = {
      selectedTarget: {
        providerAccount: "primary",
        upstreamProvider: "openai",
        model: "gpt-4o",
        credential: cred,
      },
      failureTargets: [
        {
          providerAccount: "secondary",
          upstreamProvider: "openai",
          model: "gpt-4o-mini",
          credential: cred,
        },
      ],
    };

    const events: StreamEvent[] = [];
    for await (const ev of runtime.executeLanguage(plan, {
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    })) {
      events.push(ev);
    }

    expect(target1Calls).toBe(1);
    expect(target2Calls).toBe(1);

    const delta = events.find((e) => e.type === "content_block_delta");
    expect(delta).toBeDefined();
    expect((delta as any).delta.text).toBe("Fallback response");
  });

  it("extracts user-declared models from ProviderEffectiveConfig into TurnSnapshot catalog", async () => {
    const configStore = new ProviderConfigStore(":memory:");
    await configStore.updateOverlay(
      {
        providers: {
          "custom-llm": {
            adapter: "pi-ai",
            upstreamProvider: "custom-llm",
            credential: { kind: "none" },
            models: {
              "my-custom-model-70b": {
                displayName: "Custom Model 70B",
                contextWindow: 64_000,
                capabilities: {
                  toolUse: true,
                  streaming: true,
                  vision: true,
                  imageGenerate: true,
                },
                supportedReasoningLevels: ["low", "high"],
              },
            },
          } as any,
        },
      },
      0,
    );

    const runtime = new ProviderRuntime({ configStore });
    const snapshot = await runtime.createTurnSnapshot();

    const customModel = snapshot.catalog.find((m) => m.id === "my-custom-model-70b");
    expect(customModel).toBeDefined();
    expect(customModel?.displayName).toBe("Custom Model 70B");
    expect(customModel?.provenance).toBe("user-declared");
    expect(customModel?.contextWindow).toBe(64_000);
    expect(customModel?.capabilities.imageGenerate).toBe(true);
    expect(customModel?.supportedReasoningLevels).toEqual(["low", "high"]);
  });

  it("merges target thinkingLevel into LanguageRequest during execution", async () => {
    let capturedReq: LanguageRequest | undefined;
    const mockLangBackend: LanguageBackend = {
      chatStream: async function* (target: InferenceTarget, req: LanguageRequest) {
        capturedReq = req;
        yield { type: "start", resolvedModel: { modelId: target.model, providerAccount: target.providerAccount } };
        yield { type: "finish", stopReason: "end_turn" };
      },
      chat: async () => ({
        message: { role: "assistant", content: [] },
        stopReason: "end_turn",
      }),
    };

    const adapter = new AggregateInferenceAdapter({
      language: mockLangBackend,
    });
    const credStore = new MemoryCredentialStore();
    const runtime = new ProviderRuntime({
      adapter,
      credentialStore: credStore,
    });

    const cred = await credStore.resolve({ kind: "none" });

    // 1. Target has thinkingLevel: "high", request has no thinkingLevel -> target's thinkingLevel applies
    const planWithTargetThinking = {
      selectedTarget: {
        providerAccount: "primary",
        upstreamProvider: "anthropic",
        model: "claude-3-7-sonnet-20250219",
        credential: cred,
        thinkingLevel: "high" as const,
      },
      failureTargets: [],
    };

    for await (const _ of runtime.executeLanguage(planWithTargetThinking, { messages: [] })) {}
    expect(capturedReq?.thinkingLevel).toBe("high");

    // 2. Request explicitly sets thinkingLevel: "low" -> request overrides target
    for await (const _ of runtime.executeLanguage(planWithTargetThinking, { messages: [], thinkingLevel: "low" })) {}
    expect(capturedReq?.thinkingLevel).toBe("low");
  });

  it("creates independent InvocationPlan for per-step skill overrides from same TurnSnapshot (QS-P5.4 / P5.6)", async () => {
    const credStore = new MemoryCredentialStore();
    const configStore = new ProviderConfigStore(":memory:");
    await configStore.updateOverlay({
      providers: {
        "openai-main": {
          adapter: "pi-ai",
          upstreamProvider: "openai",
          credential: { kind: "none" },
        },
        "anthropic-backup": {
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

    // 1. Default base plan for turn
    const basePlan = await runtime.resolvePlan(snapshot, "text", "standard");
    expect(basePlan.selectedTarget.providerAccount).toBe("openai-main");
    expect(basePlan.selectedTarget.model).toBe("gpt-4o");

    // 2. Skill override plan resolved from the SAME snapshot
    const skillPlan = await runtime.resolvePlan(snapshot, "text", "standard", {
      providerAccount: "anthropic-backup",
      model: "claude-3-7-sonnet",
    });
    expect(skillPlan.selectedTarget.providerAccount).toBe("anthropic-backup");
    expect(skillPlan.selectedTarget.model).toBe("claude-3-7-sonnet");

    // Both plans are pinned to the same snapshot revision
    expect(basePlan.snapshot?.revision).toBe(snapshot.revision);
    expect(skillPlan.snapshot?.revision).toBe(snapshot.revision);
    expect(basePlan).not.toBe(skillPlan);
  });
});
