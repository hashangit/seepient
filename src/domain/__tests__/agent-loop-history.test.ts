import { describe, it, expect } from "vitest";
import { runAgentLoop } from "../agent-loop.js";
import { createHookExecutor } from "../hooks.js";
import type { Message } from "../../foundations/types.js";
import { createMockRuntime } from "./test-doubles.js";

describe("agent-loop conversation history (QS-P0.2)", () => {
  it("does not insert duplicate assistant messages when response contains both text and tool calls", async () => {
    const mockRuntime = createMockRuntime([
      {
        text: "I will check the files for you.",
        toolCalls: [
          {
            id: "call-1",
            name: "get_current_datetime",
            args: {},
          },
        ],
      },
      {
        text: "The date has been verified.",
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
      runtime: mockRuntime,
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
    const mockRuntime = createMockRuntime([
      {
        text: "Hello! How can I help you today?",
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
      runtime: mockRuntime,
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
