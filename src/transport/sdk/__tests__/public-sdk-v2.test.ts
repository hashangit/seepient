import { describe, it, expect } from "vitest";
import { createSeepient } from "../seepient.js";
import { AggregateInferenceAdapter } from "../../../capabilities/inference/aggregate-adapter.js";
import type { LanguageBackend } from "../../../foundations/contracts/backend-ports.js";

describe("Public SDK v2 Instance-First Contract (QS-P6.6)", () => {
  it("initializes instance, resolves models, and executes agent run/stream", async () => {
    const mockLanguageBackend: LanguageBackend = {
      chatStream: async function* () {
        yield {
          type: "start",
          resolvedModel: { providerAccount: "main", modelId: "gpt-4o" },
        };
        yield {
          type: "content_block_start",
          index: 0,
          block: { type: "text", text: "" },
        };
        yield {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Response from SDK v2" },
        };
        yield {
          type: "content_block_stop",
          index: 0,
        };
        yield {
          type: "finish",
          stopReason: "end_turn",
          usage: { inputTokens: 5, outputTokens: 4, totalTokens: 9 },
        };
      },
      chat: async () => ({
        message: { role: "assistant", content: [{ type: "text", text: "Response from SDK v2" }] },
        stopReason: "end_turn",
      }),
    };

    const seepient = await createSeepient({
      providers: {
        main: {
          adapter: "pi-ai",
          upstreamProvider: "openai",
          credential: { kind: "none" },
        },
      },
      modelAssignments: {
        text: {
          standard: { providerAccount: "main", model: "gpt-4o" },
        },
        plan: {
          standard: { providerAccount: "main", model: "gpt-4o" },
        },
      },
      adapter: new AggregateInferenceAdapter({
        language: mockLanguageBackend,
      }),
    });

    // Test resolve
    const resolved = await seepient.resolve({ purpose: "text", tier: "standard" });
    expect(resolved.providerAccount).toBe("main");
    expect(resolved.model.id).toBe("gpt-4o");

    // Test Agent creation and execution
    const agent = await seepient.createAgent({
      purpose: "text",
      tier: "standard",
    });

    const turn = await agent.run("Hello");
    expect(turn.content[0].type).toBe("text");
    expect((turn.content[0] as any).text).toBe("Response from SDK v2");
    expect(agent.messages.length).toBe(2);

    // Test model switching
    await agent.switchModel({ model: "gpt-4o-mini" });

    // Test dispose
    await agent.dispose();
    await seepient.dispose();
  });
});
