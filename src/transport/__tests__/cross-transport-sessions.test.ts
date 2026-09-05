import { describe, it, expect, vi } from "vitest";
import { ServerSessionManager, hashKey } from "../http/session-store.js";
import { MemoryPersistenceBackend } from "../../domain/sessions/session-store.js";
import { createRestHandler, type RestHandlerContext } from "../http/rest.js";
import { handleChat } from "../ws/chat.js";
import type { ConnectionState, WebSocketHandlerContext, ChatMessage, WebSocket } from "../ws/ws-types.js";
import { EventEmitter } from "events";

function createMockReqRes(method: string, url: string, headers: Record<string, string> = {}, body = "") {
  const req = new EventEmitter() as any;
  req.method = method;
  req.url = url;
  req.headers = headers;

  const res = new EventEmitter() as any;
  res.statusCode = 200;
  res.headers = {};
  res.body = "";
  res.setHeader = function (k: string, v: string) {
    this.headers[k.toLowerCase()] = v;
  };
  res.writeHead = function (code: number, headers?: Record<string, string>) {
    this.statusCode = code;
    if (headers) {
      for (const [k, v] of Object.entries(headers)) {
        this.headers[k.toLowerCase()] = v;
      }
    }
  };
  res.end = function (data?: string) {
    if (data) this.body += data;
    this.emit("finish");
  };

  return { req, res };
}

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

describe("Cross-Transport Session Lifecycle (Spec 021-2 / T014, QS-2)", () => {
  it("WS-created session -> listed by GET /v1/sessions -> resumed by 2nd WS -> invisible to 2nd key", async () => {
    const backend = new MemoryPersistenceBackend();
    const sessionManager = new ServerSessionManager({ backend });

    const key1 = "sk_test_key_1";
    const key1Hash = hashKey(key1);

    const key2 = "sk_test_key_2";
    const key2Hash = hashKey(key2);

    // Context for WS
    const wsCtx: WebSocketHandlerContext = {
      sessionManager,
      streamText: (options) => {
        options.onText("Answer: " + options.message);
        options.onDone({
          text: "Answer: " + options.message,
          usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10, cost: 0 },
          finishReason: "stop",
        });
      },
      listModels: () => ({}),
      listSkills: () => [],
    };

    // Context for REST
    const restCtx: RestHandlerContext = {
      version: "0.7.0",
      startTime: Date.now(),
      sessionManager,
      generateText: async (opts) => ({
        text: "Rest Echo: " + opts.message,
        toolCalls: [],
        steps: [],
        messages: [],
        usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10, cost: 0 },
        finishReason: "stop",
      }),
      listModels: () => ({}),
      listSkills: () => [],
    };

    const restHandler = createRestHandler(restCtx);

    // 1. First WS connection using key1 creates session 'qs2-session'
    const { ws: ws1 } = createMockWs();
    const state1: ConnectionState = {
      sessionId: null,
      activeChats: new Set(),
      activeProvider: "openai",
      activeModel: "gpt-4o",
      apiKeyHash: key1Hash,
      apiKey: {
        keyHash: key1Hash,
        rawKey: key1,
        key: key1,
        scopes: ["agent:run", "agent:read"],
        created: new Date().toISOString(),
        label: "test1",
      },
    };

    const msg1: ChatMessage = {
      type: "chat",
      id: "ws-m1",
      message: "Hello from WS turn 1",
      sessionId: "qs2-session",
    };

    await handleChat(ws1, msg1, state1, wsCtx);

    // Verify session state in sessionManager
    const s1 = await sessionManager.getSession("qs2-session", key1Hash);
    expect(s1).not.toBeNull();
    expect(s1!.messages.length).toBe(2);
    expect(s1!.messages[0].content).toBe("Hello from WS turn 1");
    expect(s1!.messages[1].content).toBe("Answer: Hello from WS turn 1");

    // 2. GET /v1/sessions using key1 lists 'qs2-session'
    const key1Summaries = sessionManager.getSessionsByKey(key1Hash);
    expect(key1Summaries.some((s) => s.id === "qs2-session")).toBe(true);
    expect(key1Summaries.find((s) => s.id === "qs2-session")!.messageCount).toBe(2);

    // 3. Second API key cannot see qs2-session
    const state2: ConnectionState = {
      sessionId: null,
      activeChats: new Set(),
      activeProvider: "openai",
      activeModel: "gpt-4o",
      apiKeyHash: key2Hash,
      apiKey: {
        keyHash: key2Hash,
        rawKey: key2,
        key: key2,
        scopes: ["agent:run", "agent:read"],
        created: new Date().toISOString(),
        label: "test2",
      },
    };

    const foreignSession = await sessionManager.getSession("qs2-session", key2Hash);
    expect(foreignSession).toBeNull();

    const key2List = sessionManager.getSessionsByKey(key2Hash);
    expect(key2List.some((s) => s.id === "qs2-session")).toBe(false);

    // 4. Second WS connection using key1 resumes 'qs2-session'
    const { ws: ws2 } = createMockWs();
    const stateConn2: ConnectionState = {
      sessionId: null,
      activeChats: new Set(),
      activeProvider: "openai",
      activeModel: "gpt-4o",
      apiKeyHash: key1Hash,
      apiKey: state1.apiKey,
    };

    const msg2: ChatMessage = {
      type: "chat",
      id: "ws-m2",
      message: "Hello from WS turn 2 (resumed)",
      sessionId: "qs2-session",
    };

    await handleChat(ws2, msg2, stateConn2, wsCtx);

    const resumedSession = await sessionManager.getSession("qs2-session", key1Hash);
    expect(resumedSession).not.toBeNull();
    expect(resumedSession!.messages.length).toBe(4);
    expect(resumedSession!.messages[2].content).toBe("Hello from WS turn 2 (resumed)");
    expect(resumedSession!.messages[3].content).toBe("Answer: Hello from WS turn 2 (resumed)");
  });
});
