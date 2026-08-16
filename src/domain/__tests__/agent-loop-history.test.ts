import { describe, it, expect, vi } from "vitest";
import { runAgentLoop } from "../agent-loop.js";
import { createHookExecutor } from "../hooks.js";
import type { Message } from "../../foundations/types.js";
import type { LLMProvider, ProviderResponse } from "../../foundations/contracts/llm.js";

function createMockProvider(responses: ProviderResponse[]): LLMProvider {
  let callIndex = 0;
  return {
    type: "openai",
    model: "gpt-mock",
    async chat(): Promise<ProviderResponse> {
      const resp = responses[callIndex] ?? { content: "Done" };
      callIndex++;
      return resp;
    },
  };
}

describe("agent-loop conversation history (QS-P0.2)", () => {
  it("does not insert duplicate assistant messages when response contains both text and tool calls", async () => {
    const mockProvider = createMockProvider([
      {
        content: "I will check the files for you.",
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            name: "get_current_datetime",
            arguments: "{}",
          },
        ],
      },
      {
        content: "The date has been verified.",
      },
    ]);

    const messages: Message[] = [
      {
        id: "msg-1",
        role: "user",
        content: "What time is it?",
        timestamp: Date.now(),
      },
    ];

    const result = await runAgentLoop({
      provider: mockProvider,
      model: "gpt-mock",
      messages,
      toolDefs: [],
      maxSteps: 5,
      hooks: createHookExecutor(),
      autoConfirm: true,
    });

    const assistantMessages = result.messages.filter((m) => m.role === "assistant");
    // Turn 1: 1 assistant message (with content and toolCalls)
    // Turn 2: 1 assistant message (with final content)
    // Total assistant messages should be exactly 2, NOT 3.
    expect(assistantMessages.length).toBe(2);

    expect(assistantMessages[0].content).toBe("I will check the files for you.");
    expect(assistantMessages[0].toolCalls?.length).toBe(1);
    expect(assistantMessages[0].toolCalls?.[0].name).toBe("get_current_datetime");

    expect(assistantMessages[1].content).toBe("The date has been verified.");
    expect(assistantMessages[1].toolCalls).toBeUndefined();
  });

  it("records a single assistant message for pure text turns", async () => {
    const mockProvider = createMockProvider([
      {
        content: "Hello! How can I help you today?",
      },
    ]);

    const messages: Message[] = [
      {
        id: "msg-1",
        role: "user",
        content: "Hello",
        timestamp: Date.now(),
      },
    ];

    const result = await runAgentLoop({
      provider: mockProvider,
      model: "gpt-mock",
      messages,
      toolDefs: [],
      maxSteps: 5,
      hooks: createHookExecutor(),
    });

    const assistantMessages = result.messages.filter((m) => m.role === "assistant");
    expect(assistantMessages.length).toBe(1);
    expect(assistantMessages[0].content).toBe("Hello! How can I help you today?");
  });
});
