import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Message } from "../../../core/types.js";
import type { ProviderResponse } from "../../../providers/types.js";

/**
 * Regression test for the Server history bug (spec 002 §3.1):
 *
 * `serverStreamText` / `serverGenerateText` previously built a fresh
 * `messages: [userMsg]` on every call, so turn 2 was processed with zero
 * prior context unless the client resent full history. CLI/SDK thread
 * history; Server must match parity (spec §3.2).
 *
 * This test MUST fail before the fix (T006) and pass after (T007).
 */

// ── Stub provider ─────────────────────────────────────────────────────
// Captures the messages array it was invoked with so the test can assert
// the prior turn was visible to the loop on turn 2. Signature matches the
// real LLMProvider.chat(): (messages, toolDefs, options) => ProviderResponse.

const capturedCalls: Message[][] = [];

const stubProvider = {
  chat: vi.fn(
    async (messages: Message[]): Promise<ProviderResponse> => {
      capturedCalls.push(messages);
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      return { content: `reply to: ${lastUser?.content ?? ""}` };
    },
  ),
  chatStream: vi.fn(async function* (): AsyncIterable<unknown> {
    // Not exercised — serverStreamText emits 'text' steps via the non-stream path.
  }),
};

// Mock the provider resolver so no API key / network is required.
vi.mock("../../../core/provider-resolver.js", () => ({
  getProvider: vi.fn(async () => ({
    provider: stubProvider,
    model: "stub-model",
  })),
}));

// Mock tool resolution so no real tools load.
vi.mock("../../../core/tool-executor.js", () => ({
  resolveTools: vi.fn(() => []),
  getAllToolDefinitions: vi.fn(() => []),
  getAllToolModules: vi.fn(() => []),
  normalizeToolResult: vi.fn(),
  executeTool: vi.fn(),
}));

// Import AFTER mocks are registered.
const { serverStreamText } = await import("../server-core.js");

function runTurn(opts: { message: string; messages?: Message[]; sessionId?: string }): Promise<{ text: string }> {
  let text = "";
  return new Promise((resolve, reject) => {
    serverStreamText(
      {
        message: opts.message,
        messages: opts.messages,
        sessionId: opts.sessionId,
        maxSteps: 1,
        onText: (delta) => { text += delta; },
        onToolCall: () => {},
        onToolResult: () => {},
        onStep: () => {},
        onError: (e) => reject(new Error(e.message)),
        onDone: (r) => resolve({ text: r.text }),
      },
      "moderate",
    ).catch(reject);
  });
}

describe("serverStreamText — multi-turn history (spec 002 §3.1)", () => {
  beforeEach(() => {
    capturedCalls.length = 0;
    stubProvider.chat.mockClear();
  });

  it("threads conversation history across turns when seeded with prior messages", async () => {
    // Turn-1 history that a real session would have accumulated.
    const history: Message[] = [
      { id: "u1", role: "user", content: "my name is Alice", timestamp: 1 },
      { id: "a1", role: "assistant", content: "nice to meet you, Alice", timestamp: 2 },
    ];

    // Turn 2: the fix passes the full session history into the loop so the
    // model can see "Alice".
    await runTurn({ message: "what's my name?", messages: history, sessionId: "sess-1" });

    expect(capturedCalls.length).toBe(1);
    const seen = capturedCalls[0];

    // The fix guarantees the prior turn ("my name is Alice") reaches the loop.
    const sawAlice = seen.some((m) => m.content.includes("Alice"));
    expect(
      sawAlice,
      "turn 2 should have received turn-1 history (the Server history bug)",
    ).toBe(true);
    // And the new turn-2 user message is appended.
    const sawFollowup = seen.some((m) => m.role === "user" && m.content.includes("what's my name"));
    expect(sawFollowup).toBe(true);
  });

  it("starts from an empty history when no messages are seeded (backward compatible)", async () => {
    await runTurn({ message: "hello" });
    const seen = capturedCalls[0];
    expect(seen.length).toBe(1);
    expect(seen[0].role).toBe("user");
    expect(seen[0].content).toBe("hello");
  });

  it("exposes the accumulated text via onDone", async () => {
    const result = await runTurn({ message: "hi" });
    expect(result.text).toBe("reply to: hi");
  });
});
