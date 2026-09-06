import { describe, it, expect, vi } from "vitest";
import { handleChat, handleAbort } from "../chat.js";
import { handleResume, handleReconnect } from "../session-control.js";
import { ServerSessionManager } from "../../http/session-store.js";
import { MemoryPersistenceBackend } from "../../../domain/sessions/session-store.js";
import type { ConnectionState, WebSocketHandlerContext, ChatMessage, WebSocket } from "../ws-types.js";
import { createConnectionRegistry } from "../connection-registry.js";

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
      apiKey: {
        keyHash: "test-key-hash",
        scopes: ["agent:run", "agent:read"],
        created: new Date().toISOString(),
        label: "chat-session-test",
      },
    } as any;

    let streamOptionsCaptured: any = null;
    const ctx: WebSocketHandlerContext = {
        registry: createConnectionRegistry(),
      sessionManager,
      streamText: async (options) => {
        streamOptionsCaptured = options;
        // User message should already be stored before streaming executes
        const inProgress = await sessionManager.getSession("client-sess-1", "test-key-hash");
        expect(inProgress).not.toBeNull();
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

    await handleChat(ws, chatMsg, state, ctx);

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
      metadata: {
        apiKeyHash: "test-key-hash",
        apiKey: {
          keyHash: "test-key-hash",
          scopes: ["agent:run", "agent:read"],
          created: new Date().toISOString(),
          label: "chat-session-test",
        },
      },
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
      apiKey: {
        keyHash: "test-key-hash",
        scopes: ["agent:run", "agent:read"],
        created: new Date().toISOString(),
        label: "chat-session-test",
      },
    } as any;

    const ctx: WebSocketHandlerContext = {
        registry: createConnectionRegistry(),
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
      apiKey: {
        keyHash: "test-key-hash",
        scopes: ["agent:run", "agent:read"],
        created: new Date().toISOString(),
        label: "chat-session-test",
      },
    } as any;

    let finishStream: (() => void) | null = null;
    const ctx: WebSocketHandlerContext = {
        registry: createConnectionRegistry(),
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
      apiKey: {
        keyHash: "test-key-hash",
        scopes: ["agent:run", "agent:read"],
        created: new Date().toISOString(),
        label: "chat-session-test",
      },
    } as any;

    let aborted = false;
    const ctx: WebSocketHandlerContext = {
        registry: createConnectionRegistry(),
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

  it("passes prior turn history to streamText on turn 2 (W005)", async () => {
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
      apiKey: {
        keyHash: "test-key-hash",
        scopes: ["agent:run", "agent:read"],
        created: new Date().toISOString(),
        label: "chat-session-test",
      },
    } as any;

    let capturedStreamOptions: any = null;
    const ctx: WebSocketHandlerContext = {
        registry: createConnectionRegistry(),
      sessionManager,
      streamText: (options) => {
        capturedStreamOptions = options;
        options.onDone({
          text: `Echo: ${options.message}`,
          usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10, cost: 0 },
          finishReason: "stop",
        });
      },
      listModels: () => ({}),
      listSkills: () => [],
    };

    // Turn 1
    handleChat(ws, { type: "chat", id: "m1", message: "Turn 1 user", sessionId: "history-sess" }, state, ctx);
    await new Promise((r) => setTimeout(r, 10));
    expect(capturedStreamOptions.history).toEqual([]);

    // Turn 2
    handleChat(ws, { type: "chat", id: "m2", message: "Turn 2 user", sessionId: "history-sess" }, state, ctx);
    await new Promise((r) => setTimeout(r, 10));

    expect(capturedStreamOptions.history.length).toBe(2);
    expect(capturedStreamOptions.history[0].content).toBe("Turn 1 user");
    expect(capturedStreamOptions.history[0].role).toBe("user");
    expect(capturedStreamOptions.history[1].content).toBe("Echo: Turn 1 user");
    expect(capturedStreamOptions.history[1].role).toBe("assistant");
    expect(capturedStreamOptions.message).toBe("Turn 2 user");
  });

  it("persists nothing when chat has no sessionId and connection has no session (W007 regression guard)", async () => {
    const backend = new MemoryPersistenceBackend();
    const saveSpy = vi.spyOn(backend, "save");
    const sessionManager = new ServerSessionManager({ backend });
    const { ws, sent } = createMockWs();

    const state: ConnectionState = {
      sessionId: null,
      activeChats: new Set(),
      currentAbortController: null,
      activeProvider: null,
      activeModel: null,
      apiKeyHash: "test-key-hash",
      apiKey: {
        keyHash: "test-key-hash",
        scopes: ["agent:run", "agent:read"],
        created: new Date().toISOString(),
        label: "chat-session-test",
      },
    } as any;

    let streamCaptured: any = null;
    const ctx: WebSocketHandlerContext = {
        registry: createConnectionRegistry(),
      sessionManager,
      streamText: (options) => {
        streamCaptured = options;
        options.onText("Stateless response");
        options.onDone({
          text: "Stateless response",
          usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10, cost: 0 },
          finishReason: "stop",
        });
      },
      listModels: () => ({}),
      listSkills: () => [],
    };

    const chatMsg: ChatMessage = {
      type: "chat",
      id: "msg-stateless-1",
      message: "Hello stateless",
    };

    handleChat(ws, chatMsg, state, ctx);
    await new Promise((r) => setTimeout(r, 15));

    // Connection state must still have no session
    expect(state.sessionId).toBeNull();

    // Stream options received no sessionId
    expect(streamCaptured.sessionId).toBeUndefined();

    // SessionManager has 0 sessions tracked
    const sessions = sessionManager.getSessionsByKey("test-key-hash");
    expect(sessions.length).toBe(0);

    // Persistence backend was never called
    expect(saveSpy).not.toHaveBeenCalled();

    // WS received ack and done
    expect(sent.some((m) => m.type === "ack")).toBe(true);
    expect(sent.some((m) => m.type === "done")).toBe(true);
  });

  it("throwing addMessage emits error frame and keeps connection usable (W009)", async () => {
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
      apiKey: {
        keyHash: "test-key-hash",
        scopes: ["agent:run", "agent:read"],
        created: new Date().toISOString(),
        label: "chat-session-test",
      },
    } as any;

    // Spy on addMessage to throw
    vi.spyOn(sessionManager, "addMessage").mockImplementationOnce(() => {
      throw new Error("Disk full on addMessage");
    });

    const ctx: WebSocketHandlerContext = {
        registry: createConnectionRegistry(),
      sessionManager,
      streamText: vi.fn(),
      listModels: () => ({}),
      listSkills: () => [],
    };

    await handleChat(
      ws,
      { type: "chat", id: "throw-user-msg", message: "Hello", sessionId: "throw-sess" },
      state,
      ctx,
    );

    // Must receive SESSION_ERROR error frame
    const err = sent.find((m) => m.type === "error" && m.code === "SESSION_ERROR");
    expect(err).toBeDefined();

    // Active chats must be empty
    expect(state.activeChats.size).toBe(0);

    // Subsequent chat on this connection must succeed without error
    const subsequentCtx: WebSocketHandlerContext = {
        registry: createConnectionRegistry(),
      sessionManager,
      streamText: (options) => {
        options.onDone({
          text: "Subsequent ok",
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, cost: 0 },
          finishReason: "stop",
        });
      },
      listModels: () => ({}),
      listSkills: () => [],
    };

    await handleChat(
      ws,
      { type: "chat", id: "subsequent-msg", message: "Hello again" },
      state,
      subsequentCtx,
    );

    expect(sent.some((m) => m.type === "done" && m.serverMsgId)).toBe(true);
    expect(state.activeChats.size).toBe(0);
  });

  it("double onDone / error + onDone invocation is single-fire with no assistant empty rows (W009)", async () => {
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
      apiKey: {
        keyHash: "test-key-hash",
        scopes: ["agent:run", "agent:read"],
        created: new Date().toISOString(),
        label: "chat-session-test",
      },
    } as any;

    const ctx: WebSocketHandlerContext = {
        registry: createConnectionRegistry(),
      sessionManager,
      streamText: (options) => {
        // Simulate server-core calling onError AND onDone
        options.onError({
          code: "PROVIDER_ERROR",
          message: "Model timed out",
        });
        options.onDone({
          text: "",
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0 },
          finishReason: "error",
        });
      },
      listModels: () => ({}),
      listSkills: () => [],
    };

    await handleChat(
      ws,
      { type: "chat", id: "double-done-msg", message: "Trigger fail", sessionId: "fail-sess" },
      state,
      ctx,
    );

    // Exactly one error frame, NO done frame
    const errFrames = sent.filter((m) => m.type === "error");
    expect(errFrames.length).toBe(1);
    expect(errFrames[0].code).toBe("PROVIDER_ERROR");

    const doneFrames = sent.filter((m) => m.type === "done");
    expect(doneFrames.length).toBe(0);

    // Session must NOT have empty assistant message persisted
    const session = await sessionManager.getSession("fail-sess", "test-key-hash");
    expect(session).not.toBeNull();
    // Only user message, no empty assistant row
    expect(session!.messages.length).toBe(1);
    expect(session!.messages[0].role).toBe("user");

    // Connection must be clear
    expect(state.activeChats.size).toBe(0);
  });

  it("eviction mid-stream surfaces as error frame and keeps connection usable (W009)", async () => {
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
      apiKey: {
        keyHash: "test-key-hash",
        scopes: ["agent:run", "agent:read"],
        created: new Date().toISOString(),
        label: "chat-session-test",
      },
    } as any;

    const ctx: WebSocketHandlerContext = {
        registry: createConnectionRegistry(),
      sessionManager,
      streamText: (options) => {
        // W152: deleteSession now REFUSES while the turn is in flight — the
        // session must survive the mid-stream eviction attempt. Simulate the
        // legacy loss directly (backend-driven eviction) so the error-frame
        // contract of this test is still exercised.
        (sessionManager as any).sessions.delete("evicted-sess");
        options.onDone({
          text: "Stream completed after eviction",
          usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10, cost: 0 },
          finishReason: "stop",
        });
      },
      listModels: () => ({}),
      listSkills: () => [],
    };

    await handleChat(
      ws,
      { type: "chat", id: "evicted-msg", message: "Will be evicted", sessionId: "evicted-sess" },
      state,
      ctx,
    );

    // Error frame sent for session error
    const errFrame = sent.find((m) => m.type === "error" && m.code === "SESSION_ERROR");
    expect(errFrame).toBeDefined();

    // Connection stays usable
    expect(state.activeChats.size).toBe(0);
  });

  it("foreign-owned session id produces SESSION_NOT_FOUND without leaking existence (W011)", async () => {
    const backend = new MemoryPersistenceBackend();
    const sessionManager = new ServerSessionManager({ backend });
    const { ws, sent } = createMockWs();

    // Create a session owned by another key
    await sessionManager.createSession("other-key", {
      id: "foreign-session-123",
      apiKeyHash: "other-key-hash",
    });

    const state: ConnectionState = {
      sessionId: null,
      activeChats: new Set(),
      currentAbortController: null,
      activeProvider: null,
      activeModel: null,
      apiKeyHash: "attacker-key-hash",
      apiKey: {
        keyHash: "attacker-key-hash",
        scopes: ["agent:run", "agent:read"],
        created: new Date().toISOString(),
        label: "chat-session-test",
      },
    } as any;

    const ctx: WebSocketHandlerContext = {
        registry: createConnectionRegistry(),
      sessionManager,
      streamText: vi.fn(),
      listModels: () => ({}),
      listSkills: () => [],
    };

    await handleChat(
      ws,
      { type: "chat", id: "probe-msg", message: "probe", sessionId: "foreign-session-123" },
      state,
      ctx,
    );

    const errFrame = sent.find((m) => m.type === "error");
    expect(errFrame).toBeDefined();
    expect(errFrame.code).toBe("SESSION_NOT_FOUND");
    expect(errFrame.message).toMatch(/not found or expired/i);
    expect(JSON.stringify(sent)).not.toMatch(/already exists/i);
    expect(state.activeChats.size).toBe(0);
  });

  it("rejects resume and reconnect during in-flight turn with REQUEST_IN_FLIGHT, releasing acquired lock on completion (W034)", async () => {
    const backend = new MemoryPersistenceBackend();
    const sessionManager = new ServerSessionManager({ backend });
    const { ws: ws1 } = createMockWs();
    const { ws: ws2, sent: sent2 } = createMockWs();

    // Pre-create target session for resume
    await sessionManager.createSession("key-1", {
      id: "target-resume-sess",
      apiKeyHash: "test-hash",
    });

    const state: ConnectionState = {
      sessionId: null,
      activeChats: new Set(),
      currentAbortController: null,
      activeProvider: null,
      activeModel: null,
      apiKeyHash: "test-hash",
      apiKey: {
        keyHash: "test-hash",
        scopes: ["agent:run", "agent:read"],
        created: new Date().toISOString(),
        label: "chat-session-test",
      },
    } as any;

    let finishStream: (() => void) | null = null;
    const ctx: WebSocketHandlerContext = {
        registry: createConnectionRegistry(),
      sessionManager,
      streamText: (options) => {
        return new Promise<void>((resolve) => {
          finishStream = () => {
            options.onDone({
              text: "Done",
              usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, cost: 0 },
              finishReason: "stop",
            });
            resolve();
          };
        });
      },
      listModels: () => ({}),
      listSkills: () => [],
    };

    // Start chat turn on sess-1
    const chatPromise = handleChat(
      ws1,
      { type: "chat", id: "msg-w034", message: "Start streaming", sessionId: "sess-1" },
      state,
      ctx,
    );

    // Wait until stream has acquired turn and registered active chat
    await new Promise((r) => setTimeout(r, 10));
    expect(state.activeChats.size).toBe(1);

    // Attempt resume while turn is active on this connection
    await handleResume(
      ws2,
      { type: "resume", sessionId: "target-resume-sess" },
      state,
      ctx,
    );
    const resumeErr = sent2.find((m) => m.type === "error" && m.code === "REQUEST_IN_FLIGHT");
    expect(resumeErr).toBeDefined();
    expect(resumeErr.message).toMatch(/in flight/i);

    // Attempt reconnect while turn is active on this connection
    await handleReconnect(
      ws2,
      { type: "reconnect", sessionId: "target-resume-sess" },
      state,
      ctx,
    );
    const reconnectErr = sent2.filter((m) => m.type === "error" && m.code === "REQUEST_IN_FLIGHT");
    expect(reconnectErr.length).toBe(2);

    // Finish the streaming turn
    finishStream!();
    await chatPromise;

    // Both connection active chats and session turn lock are now clear
    expect(state.activeChats.size).toBe(0);
    expect(sessionManager.acquireTurn("sess-1")).toBe(true);
    sessionManager.releaseTurn("sess-1");
  });

  it("normalizes empty string or whitespace sessionId in chat message as stateless (W038.1)", async () => {
    const backend = new MemoryPersistenceBackend();
    const sessionManager = new ServerSessionManager({ backend });
    const { ws } = createMockWs();

    const state: ConnectionState = {
      sessionId: null,
      activeChats: new Set(),
      currentAbortController: null,
      activeProvider: null,
      activeModel: null,
      apiKeyHash: "test-hash",
      apiKey: {
        keyHash: "test-hash",
        scopes: ["agent:run", "agent:read"],
        created: new Date().toISOString(),
        label: "chat-session-test",
      },
    } as any;

    let capturedSessionId: string | undefined = "NOT_SET";
    const ctx: WebSocketHandlerContext = {
        registry: createConnectionRegistry(),
      sessionManager,
      streamText: (options) => {
        capturedSessionId = options.sessionId;
        options.onDone({
          text: "Stateless reply",
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, cost: 0 },
          finishReason: "stop",
        });
      },
      listModels: () => ({}),
      listSkills: () => [],
    };

    await handleChat(
      ws,
      { type: "chat", id: "msg-empty-sess", message: "Hi", sessionId: "   " },
      state,
      ctx,
    );

    expect(capturedSessionId).toBeUndefined();
    expect(state.sessionId).toBeNull();
  });

  it("rejects cross-connection turn contention on same session with REQUEST_IN_FLIGHT (W038.8)", async () => {
    const backend = new MemoryPersistenceBackend();
    const sessionManager = new ServerSessionManager({ backend });
    const { ws: ws1 } = createMockWs();
    const { ws: ws2, sent: sent2 } = createMockWs();

    // Pre-create shared session
    await sessionManager.createSession("key-1", {
      id: "shared-sess-ws",
      apiKeyHash: "test-hash",
    });

    const state1: ConnectionState = {
      sessionId: null,
      activeChats: new Set(),
      currentAbortController: null,
      activeProvider: null,
      activeModel: null,
      apiKeyHash: "test-hash",
      apiKey: {
        keyHash: "test-hash",
        scopes: ["agent:run", "agent:read"],
        created: new Date().toISOString(),
        label: "chat-session-test",
      },
    } as any;

    const state2: ConnectionState = {
      sessionId: null,
      activeChats: new Set(),
      currentAbortController: null,
      activeProvider: null,
      activeModel: null,
      apiKeyHash: "test-hash",
      apiKey: {
        keyHash: "test-hash",
        scopes: ["agent:run", "agent:read"],
        created: new Date().toISOString(),
        label: "chat-session-test",
      },
    } as any;

    let finishConn1: (() => void) | null = null;
    const ctx1: WebSocketHandlerContext = {
      registry: createConnectionRegistry(),
      sessionManager,
      streamText: (options) => {
        return new Promise<void>((resolve) => {
          finishConn1 = () => {
            options.onDone({
              text: "Done 1",
              usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, cost: 0 },
              finishReason: "stop",
            });
            resolve();
          };
        });
      },
      listModels: () => ({}),
      listSkills: () => [],
    };

    const ctx2: WebSocketHandlerContext = {
      registry: createConnectionRegistry(),
      sessionManager,
      streamText: vi.fn(),
      listModels: () => ({}),
      listSkills: () => [],
    };

    // Connection 1 begins turn on shared-sess-ws
    const chatPromise1 = handleChat(
      ws1,
      { type: "chat", id: "msg-c1", message: "Turn from conn 1", sessionId: "shared-sess-ws" },
      state1,
      ctx1,
    );

    await new Promise((r) => setTimeout(r, 10));

    // Connection 2 attempts turn on same shared-sess-ws
    await handleChat(
      ws2,
      { type: "chat", id: "msg-c2", message: "Turn from conn 2", sessionId: "shared-sess-ws" },
      state2,
      ctx2,
    );

    const busyErr = sent2.find((m) => m.type === "error" && m.code === "REQUEST_IN_FLIGHT");
    expect(busyErr).toBeDefined();
    expect(busyErr.retryable).toBe(true);

    // Finish connection 1 turn
    finishConn1!();
    await chatPromise1;

    // After completion, lock is released
    expect(sessionManager.acquireTurn("shared-sess-ws")).toBe(true);
    sessionManager.releaseTurn("shared-sess-ws");
  });

  it("releases session turn lock immediately when aborted via handleAbort (W038.9)", async () => {
    const backend = new MemoryPersistenceBackend();
    const sessionManager = new ServerSessionManager({ backend });
    const { ws, sent } = createMockWs();

    const state: ConnectionState = {
      sessionId: null,
      activeChats: new Set(),
      currentAbortController: null,
      activeProvider: null,
      activeModel: null,
      apiKeyHash: "test-hash",
      apiKey: {
        keyHash: "test-hash",
        scopes: ["agent:run", "agent:read"],
        created: new Date().toISOString(),
        label: "chat-session-test",
      },
    } as any;

    const ctx: WebSocketHandlerContext = {
        registry: createConnectionRegistry(),
      sessionManager,
      streamText: () => {
        // Stream hangs until aborted
        return new Promise<void>(() => {});
      },
      listModels: () => ({}),
      listSkills: () => [],
    };

    const chatPromise = handleChat(
      ws,
      { type: "chat", id: "msg-abort", message: "To be aborted", sessionId: "abort-sess" },
      state,
      ctx,
    );

    await new Promise((r) => setTimeout(r, 10));
    expect(state.activeChats.size).toBe(1);

    // Trigger handleAbort
    handleAbort(ws, { type: "abort" }, state);

    // Chat should resolve immediately because abort event listener resolved the promise
    await chatPromise;

    expect(state.activeChats.size).toBe(0);
    const abortMsg = sent.find((m) => m.type === "error" && m.code === "ABORTED");
    expect(abortMsg).toBeDefined();

    // Lock must be released
    expect(sessionManager.acquireTurn("abort-sess")).toBe(true);
    sessionManager.releaseTurn("abort-sess");
  });
});

