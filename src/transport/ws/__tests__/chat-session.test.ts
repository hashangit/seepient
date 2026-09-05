import { describe, it, expect, vi } from "vitest";
import { handleChat, handleAbort } from "../chat.js";
import { ServerSessionManager } from "../../http/session-store.js";
import { MemoryPersistenceBackend } from "../../../domain/sessions/session-store.js";
import type { ConnectionState, WebSocketHandlerContext, ChatMessage, WebSocket } from "../ws-types.js";

function createMockWs() {
  const sent: any[] = [];
  const ws = {
    send: (data: string) => sent.push(JSON.parse(data)),
    readyState: 1,
    close: vi.fn(),
    on: vi.fn(),
    ping: vi.fn(),
  } as unknown as WebSocket;
  return { ws, sent };
}

describe("WebSocket Session Lifecycle & Concurrency Guard (Spec 021-2 / FR-004, FR-016)", () => {
  it("registers session under client ID, records user message before stream and assistant on done", async () => {
    const backend = new MemoryPersistenceBackend();
    const sessionManager = new ServerSessionManager({ backend });
    const { ws, sent } = createMockWs();

    const state: ConnectionState = {
      sessionId: null,
      activeChats: new Set(),
      currentAbortController: null,
      activeProvider: null,
      activeModel: null,
      apiKeyHash: "test-key-hash",
    } as any;

    let streamOptionsCaptured: any = null;
    const ctx: WebSocketHandlerContext = {
      sessionManager,
      streamText: (options) => {
        streamOptionsCaptured = options;
        // User message should already be stored before streaming executes
        const inProgress = sessionManager.getSession("client-sess-1", "test-key-hash");
        expect(inProgress).toBeDefined();
        options.onText("Hello back");
        options.onDone({
          text: "Hello back",
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, cost: 0 },
          finishReason: "stop",
        });
      },
      listModels: () => ({}),
      listSkills: () => [],
    };

    const chatMsg: ChatMessage = {
      type: "chat",
      id: "msg-1",
      message: "Hello agent",
      sessionId: "client-sess-1",
    };

    handleChat(ws, chatMsg, state, ctx);

    // Give microtasks a tick if createSession is async
    await new Promise((r) => setTimeout(r, 10));

    expect(state.sessionId).toBe("client-sess-1");
    const session = await sessionManager.getSession("client-sess-1", "test-key-hash");
    expect(session).not.toBeNull();
    expect(session!.messages.length).toBe(2);
    expect(session!.messages[0].role).toBe("user");
    expect(session!.messages[0].content).toBe("Hello agent");
    expect(session!.messages[1].role).toBe("assistant");
    expect(session!.messages[1].content).toBe("Hello back");

    // Ack and done sent
    expect(sent.some((m) => m.type === "ack")).toBe(true);
    expect(sent.some((m) => m.type === "done")).toBe(true);
  });

  it("adopts existing session from persistence backend on restart without overwriting history", async () => {
    const backend = new MemoryPersistenceBackend();
    await backend.save("preexisting-sess", {
      id: "preexisting-sess",
      messages: [
        { id: "m0", role: "user", content: "Previous question", timestamp: Date.now() - 1000 },
        { id: "m1", role: "assistant", content: "Previous answer", timestamp: Date.now() - 500 },
      ],
      createdAt: Date.now() - 1000,
      updatedAt: Date.now() - 500,
      provider: "openai",
      model: "gpt-4o",
    });

    const sessionManager = new ServerSessionManager({ backend });
    const { ws } = createMockWs();

    const state: ConnectionState = {
      sessionId: null,
      activeChats: new Set(),
      currentAbortController: null,
      activeProvider: null,
      activeModel: null,
      apiKeyHash: "test-key-hash",
    } as any;

    const ctx: WebSocketHandlerContext = {
      sessionManager,
      streamText: (options) => {
        options.onDone({
          text: "New answer",
          usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10, cost: 0 },
          finishReason: "stop",
        });
      },
      listModels: () => ({}),
      listSkills: () => [],
    };

    handleChat(ws, { type: "chat", id: "msg-2", message: "New question", sessionId: "preexisting-sess" }, state, ctx);
    await new Promise((r) => setTimeout(r, 10));

    const session = await sessionManager.getSession("preexisting-sess", "test-key-hash");
    expect(session).not.toBeNull();
    // Prior 2 messages + 1 new user + 1 new assistant = 4 messages
    expect(session!.messages.length).toBe(4);
    expect(session!.messages[0].content).toBe("Previous question");
  });

  it("returns REQUEST_IN_FLIGHT on concurrent chat during an active stream", async () => {
    const backend = new MemoryPersistenceBackend();
    const sessionManager = new ServerSessionManager({ backend });
    const { ws, sent } = createMockWs();

    const state: ConnectionState = {
      sessionId: null,
      activeChats: new Set(),
      currentAbortController: null,
      activeProvider: null,
      activeModel: null,
      apiKeyHash: "test-key-hash",
    } as any;

    let finishStream: (() => void) | null = null;
    const ctx: WebSocketHandlerContext = {
      sessionManager,
      streamText: (options) => {
        finishStream = () => {
          options.onDone({
            text: "Finished",
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, cost: 0 },
            finishReason: "stop",
          });
        };
      },
      listModels: () => ({}),
      listSkills: () => [],
    };

    // First chat starts streaming
    handleChat(ws, { type: "chat", id: "msg-1", message: "First message" }, state, ctx);

    // Second chat arrives before first completes
    handleChat(ws, { type: "chat", id: "msg-2", message: "Second message" }, state, ctx);

    const errorFrame = sent.find((m) => m.type === "error" && m.code === "REQUEST_IN_FLIGHT");
    expect(errorFrame).toBeDefined();
    expect(errorFrame.retryable).toBe(true);

    // Complete the first stream
    if (finishStream) (finishStream as () => void)();
  });

  it("aborts active stream when handleAbort is called", async () => {
    const backend = new MemoryPersistenceBackend();
    const sessionManager = new ServerSessionManager({ backend });
    const { ws } = createMockWs();

    const state: ConnectionState = {
      sessionId: null,
      activeChats: new Set(),
      currentAbortController: null,
      activeProvider: null,
      activeModel: null,
      apiKeyHash: "test-key-hash",
    } as any;

    let aborted = false;
    const ctx: WebSocketHandlerContext = {
      sessionManager,
      streamText: (options) => {
        options.signal?.addEventListener("abort", () => {
          aborted = true;
        });
      },
      listModels: () => ({}),
      listSkills: () => [],
    };

    handleChat(ws, { type: "chat", id: "msg-1", message: "To be aborted" }, state, ctx);
    handleAbort(ws, { type: "abort" }, state);

    expect(aborted).toBe(true);
  });
});
