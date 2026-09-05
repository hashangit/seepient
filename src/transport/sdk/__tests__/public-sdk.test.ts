import { describe, it, expect } from "vitest";
import { createSeepient } from "../seepient.js";
import { AggregateInferenceAdapter } from "../../../capabilities/inference/aggregate-adapter.js";
import type { LanguageBackend } from "../../../foundations/contracts/backend-ports.js";

describe("Public SDK Instance Contract (QS-P6.6)", () => {
  it("initializes instance, resolves models, and executes chat/chatStream", async () => {
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
          delta: { type: "text_delta", text: "Response from SDK" },
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
        message: { role: "assistant", content: [{ type: "text", text: "Response from SDK" }] },
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

    // Test execution through chat()
    const turn = await seepient.chat("Hello");
    expect(turn.text).toBe("Response from SDK");
    const dialogueMessages = seepient.getHistory().filter((m) => m.role !== "system");
    expect(dialogueMessages.length).toBe(2);

    // Test execution through chatStream()
    const stream = await seepient.chatStream("Hello again");
    let streamed = "";
    for await (const chunk of stream.textStream) {
      streamed += chunk;
    }
    expect(streamed).toBe("Response from SDK");

    // Test provider/model switching
    await seepient.switchProvider("gpt-4o-mini");

    // Test dispose
    await seepient.dispose();
  });

  it("exercises SDK management methods (FR-038 / T055)", async () => {
    const seepient = await createSeepient({});

    // 1. addProvider
    const addRes = await seepient.addProvider({
      accountId: "anthropic-acc",
      upstreamProvider: "anthropic",
      credential: { mode: "env", varName: "ANTHROPIC_API_KEY" },
    });
    expect(addRes.ok).toBe(true);

    // 2. setAssignment
    const setRes = await seepient.setAssignment("text", "standard", {
      providerAccount: "anthropic-acc",
      model: "claude-haiku-4-5",
    });
    expect(setRes.ok).toBe(true);
    expect(seepient.getAssignments().text?.standard?.model).toBe("claude-haiku-4-5");

    // 3. getCatalog
    const catalog = await seepient.getCatalog();
    expect(catalog.length).toBeGreaterThan(0);

    // 4. clearAssignment
    const clearRes = await seepient.clearAssignment("text", "standard");
    expect(clearRes.ok).toBe(true);
    expect(seepient.getAssignments().text?.standard).toBeUndefined();

    // 5. removeProvider
    const removeRes = await seepient.removeProvider("anthropic-acc");
    expect(removeRes.ok).toBe(true);

    await seepient.dispose();
  });
});
