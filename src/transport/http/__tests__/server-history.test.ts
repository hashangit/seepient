import { describe, it, expect } from "vitest";
import { serverGenerateText, serverStreamText, MAX_HISTORY_MESSAGES } from "../server-core.js";
import { createMockRuntime } from "../../../domain/__tests__/test-doubles.js";
import type { Message } from "../../../foundations/types.js";

describe("server-core history handling (W005)", () => {
  it("passes prior history to runAgentLoop in serverGenerateText without duplicating current message", async () => {
    let capturedMessages: any[] = [];
    const runtime = createMockRuntime((req) => {
      capturedMessages = req.messages;
      return { text: "turn 2 reply" };
    });

    const history: Message[] = [
      { id: "1", role: "user", content: "turn 1 user", timestamp: 1000 },
      { id: "2", role: "assistant", content: "turn 1 assistant", timestamp: 1001 },
    ];

    const result = await serverGenerateText({
      message: "turn 2 user",
      history,
      runtime,
    });

    expect(result.text).toBe("turn 2 reply");

    // Filter non-system messages to check history + current
    const nonSystem = capturedMessages.filter((m: any) => m.role !== "system");
    const getText = (m: any) => typeof m.content === "string" ? m.content : m.content?.[0]?.text ?? "";

    expect(nonSystem.length).toBe(3);
    expect(getText(nonSystem[0])).toBe("turn 1 user");
    expect(getText(nonSystem[1])).toBe("turn 1 assistant");
    expect(getText(nonSystem[2])).toBe("turn 2 user");
  });

  it("passes prior history in serverStreamText", async () => {
    let capturedMessages: any[] = [];
    const runtime = createMockRuntime((req) => {
      capturedMessages = req.messages;
      return { text: "stream turn 2 reply" };
    });

    const history: Message[] = [
      { id: "1", role: "user", content: "turn 1 user", timestamp: 1000 },
      { id: "2", role: "assistant", content: "turn 1 assistant", timestamp: 1001 },
    ];

    await serverStreamText({
      message: "turn 2 user",
      history,
      runtime,
      onText: () => {},
      onToolCall: () => {},
      onToolResult: () => {},
      onStep: () => {},
      onError: () => {},
      onDone: () => {},
    });

    const getText = (m: any) => typeof m.content === "string" ? m.content : m.content?.[0]?.text ?? "";

    const nonSystem = capturedMessages.filter((m: any) => m.role !== "system");
    expect(nonSystem.length).toBe(3);
    expect(getText(nonSystem[0])).toBe("turn 1 user");
    expect(getText(nonSystem[1])).toBe("turn 1 assistant");
    expect(getText(nonSystem[2])).toBe("turn 2 user");
  });

  it("caps sent history at MAX_HISTORY_MESSAGES (50) on a long session", async () => {
    let capturedMessages: any[] = [];
    const runtime = createMockRuntime((req) => {
      capturedMessages = req.messages;
      return { text: "reply to long session" };
    });

    const longHistory: Message[] = [];
    for (let i = 0; i < 70; i++) {
      longHistory.push({
        id: `msg-${i}`,
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Message ${i}`,
        timestamp: 1000 + i,
      });
    }

    await serverGenerateText({
      message: "new turn user",
      history: longHistory,
      runtime,
    });

    const getText = (m: any) => typeof m.content === "string" ? m.content : m.content?.[0]?.text ?? "";

    const nonSystem = capturedMessages.filter((m: any) => m.role !== "system");
    // Should be 50 history messages + 1 current user message = 51
    expect(nonSystem.length).toBe(MAX_HISTORY_MESSAGES + 1);
    // The first history message sent should be msg-20 (70 - 50 = 20)
    expect(getText(nonSystem[0])).toBe("Message 20");
    // The last history message should be Message 69
    expect(getText(nonSystem[nonSystem.length - 2])).toBe("Message 69");
    // The last message should be the new turn user
    expect(getText(nonSystem[nonSystem.length - 1])).toBe("new turn user");
  });
});
