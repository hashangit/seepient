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

describe("ProviderRuntime (QS-P4.6)", () => {
  it("pins an immutable TurnSnapshot for the turn duration", async () => {
    const runtime = new ProviderRuntime();
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
});
