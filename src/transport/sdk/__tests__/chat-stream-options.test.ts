import { describe, it, expect } from "vitest";
import { createSeepient } from "../seepient.js";
import { AggregateInferenceAdapter } from "../../../capabilities/inference/aggregate-adapter.js";
import type { LanguageBackend } from "../../../foundations/contracts/backend-ports.js";

describe("W019: chatStream per-call purpose and tier", () => {
  it("honors per-call purpose and tier in chatStream, and falls back to instance values when omitted", async () => {
    const invocations: string[] = [];

    const mockLanguageBackend: LanguageBackend = {
      chatStream: async function* (target) {
        invocations.push(target.model);
        yield {
          type: "start",
          resolvedModel: { providerAccount: "main", modelId: target.model },
        };
        yield {
          type: "content_block_start",
          index: 0,
          block: { type: "text", text: "" },
        };
        yield {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "done" },
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
        message: { role: "assistant", content: [{ type: "text", text: "done" }] },
        stopReason: "end_turn",
      }),
    };

    const seepient = await createSeepient({
      purpose: "text",
      tier: "standard",
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
        coding: {
          efficient: { providerAccount: "main", model: "gpt-4o-mini" },
        },
      },
      adapter: new AggregateInferenceAdapter({
        language: mockLanguageBackend,
      }),
    });

    // 1. Without per-call options: uses instance-captured purpose ("text") and tier ("standard")
    const stream1 = await seepient.chatStream("Hello 1");
    for await (const _ of stream1.textStream) {
      // consume
    }
    expect(invocations[0]).toBe("gpt-4o");

    // 2. With per-call purpose ("coding") and tier ("efficient"): overrides instance values
    const stream2 = await seepient.chatStream("Hello 2", {
      purpose: "coding",
      tier: "efficient",
    });
    for await (const _ of stream2.textStream) {
      // consume
    }
    expect(invocations[1]).toBe("gpt-4o-mini");

    await seepient.dispose();
  });
});
