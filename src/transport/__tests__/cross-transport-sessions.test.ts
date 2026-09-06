import { describe, it, expect, vi } from "vitest";
import { ServerSessionManager, hashKey } from "../http/session-store.js";
import { MemoryPersistenceBackend } from "../../domain/sessions/session-store.js";
import { createRestHandler, type RestHandlerContext } from "../http/rest.js";
import { handleChat } from "../ws/chat.js";
import type { ConnectionState, WebSocketHandlerContext, ChatMessage, WebSocket } from "../ws/ws-types.js";
import { createConnectionRegistry } from "../ws/connection-registry.js";
import { EventEmitter } from "events";
import { Readable } from "node:stream";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { generateApiKey } from "../auth/auth.js";

function createMockReqRes(method: string, url: string, headers: Record<string, string> = {}, body = "") {
  const req = Readable.from(body ? [Buffer.from(body)] : []) as any;
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
    const tempKeyPath = path.join(
      os.tmpdir(),
      `seepient-test-cross1-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
    );
    process.env.SEEPIENT_API_KEYS_FILE = tempKeyPath;
    const k1 = generateApiKey(["agent:run", "agent:read", "admin"], { filePath: tempKeyPath });
    const k2 = generateApiKey(["agent:run", "agent:read", "admin"], { filePath: tempKeyPath });
    const key1 = k1.rawKey;
    const key1Hash = hashKey(key1);
    const key2 = k2.rawKey;
    const key2Hash = hashKey(key2);

    const backend = new MemoryPersistenceBackend();
    const sessionManager = new ServerSessionManager({ backend });

    // Context for WS
    const wsCtx: WebSocketHandlerContext = {
      registry: createConnectionRegistry(),
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

    // 2. GET /v1/sessions using key1 lists 'qs2-session' via REST handler
    const reqList1 = createMockReqRes("GET", "/v1/sessions", {
      authorization: `Bearer ${key1}`,
    });
    await restHandler(reqList1.req, reqList1.res);
    expect(reqList1.res.statusCode).toBe(200);
    const resBody1 = JSON.parse(reqList1.res.body);
    expect(Array.isArray(resBody1)).toBe(true);
    expect(resBody1.some((s: any) => s.id === "qs2-session")).toBe(true);
    expect(resBody1.find((s: any) => s.id === "qs2-session")!.messageCount).toBe(2);

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

    const reqList2 = createMockReqRes("GET", "/v1/sessions", {
      authorization: `Bearer ${key2}`,
    });
    await restHandler(reqList2.req, reqList2.res);
    expect(reqList2.res.statusCode).toBe(200);
    const resBody2 = JSON.parse(reqList2.res.body);
    expect(Array.isArray(resBody2)).toBe(true);
    expect(resBody2.some((s: any) => s.id === "qs2-session")).toBe(false);

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

    try {
      fs.unlinkSync(tempKeyPath);
    } catch {}
  });

  it("enforces single writer per session across REST and WS (W006): one runs, one rejected, history not torn", async () => {
    const tempKeyPath = path.join(
      os.tmpdir(),
      `seepient-test-sw-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
    );
    process.env.SEEPIENT_API_KEYS_FILE = tempKeyPath;
    const k1 = generateApiKey(["agent:run", "admin"], { filePath: tempKeyPath });
    const key1 = k1.rawKey;
    const key1Hash = hashKey(key1);

    const backend = new MemoryPersistenceBackend();
    const sessionManager = new ServerSessionManager({ backend });

    // Create session
    const session = await sessionManager.createSession(key1, { id: "writer-lock-session" });

    // Deferred promise to pause REST turn
    let resolveRestTurn!: (val: any) => void;
    const restPromise = new Promise<any>((resolve) => {
      resolveRestTurn = resolve;
    });

    const restCtx: RestHandlerContext = {
      version: "0.7.0",
      startTime: Date.now(),
      sessionManager,
      generateText: async (opts) => {
        if (opts.sessionId === "writer-lock-session") {
          await restPromise;
        }
        return {
          text: "REST reply: " + opts.message,
          toolCalls: [],
          steps: [],
          messages: [],
          usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10, cost: 0 },
          finishReason: "stop",
        };
      },
      listModels: () => ({}),
      listSkills: () => [],
    };
    const restHandler = createRestHandler(restCtx);

    const wsCtx: WebSocketHandlerContext = {
      registry: createConnectionRegistry(),
      sessionManager,
      streamText: (options) => {
        options.onText("WS reply: " + options.message);
        options.onDone({
          text: "WS reply: " + options.message,
          usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10, cost: 0 },
          finishReason: "stop",
        });
      },
      listModels: () => ({}),
      listSkills: () => [],
    };

    // 1. Start REST turn on writer-lock-session (stays in-flight)
    const req1 = createMockReqRes(
      "POST",
      "/v1/chat",
      {
        authorization: `Bearer ${key1}`,
        "content-type": "application/json",
      },
      JSON.stringify({ message: "REST message 1", sessionId: session.id }),
    );
    let restFinished = false;
    const restRun = new Promise<void>((resolve) => {
      req1.res.on("finish", () => {
        restFinished = true;
        resolve();
      });
      restHandler(req1.req, req1.res);
    });

    // Wait microtick to ensure REST handler has started and acquired turn
    await new Promise((r) => setTimeout(r, 15));
    expect(restFinished).toBe(false);

    // 2. While REST is in-flight, a WS turn on the SAME session arrives
    const { ws, sent } = createMockWs();
    const state: ConnectionState = {
      sessionId: null,
      activeChats: new Set(),
      apiKeyHash: key1Hash,
      apiKey: {
        keyHash: key1Hash,
        rawKey: key1,
        key: key1,
        scopes: ["agent:run"],
        created: new Date().toISOString(),
        label: "test",
      },
    } as any;

    await handleChat(
      ws,
      { type: "chat", id: "ws-concurrent", message: "WS concurrent attempt", sessionId: session.id },
      state,
      wsCtx,
    );

    // WS must be rejected with REQUEST_IN_FLIGHT retryable error
    const errorFrame = sent.find((m) => m.type === "error" && m.code === "REQUEST_IN_FLIGHT");
    expect(errorFrame).toBeDefined();
    expect(errorFrame.retryable).toBe(true);

    // 3. Now let the REST turn complete
    resolveRestTurn({
      text: "REST reply: REST message 1",
      toolCalls: [],
      steps: [],
      messages: [],
      usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10, cost: 0 },
      finishReason: "stop",
    });
    await restRun;
    expect(req1.res.statusCode).toBe(200);

    // 4. Now that REST finished, a second WS turn on the SAME session succeeds
    const { ws: ws2, sent: sent2 } = createMockWs();
    const state2: ConnectionState = {
      sessionId: null,
      activeChats: new Set(),
      apiKeyHash: key1Hash,
      apiKey: state.apiKey,
    } as any;

    await handleChat(
      ws2,
      { type: "chat", id: "ws-subsequent", message: "WS subsequent turn", sessionId: session.id },
      state2,
      wsCtx,
    );
    await new Promise((r) => setTimeout(r, 15));

    expect(sent2.some((m) => m.type === "done")).toBe(true);

    // 5. Verify history is NOT torn
    const finalSession = await sessionManager.getSession(session.id, key1Hash);
    expect(finalSession).not.toBeNull();
    // 2 messages from REST (user + assistant) + 2 messages from WS (user + assistant) = 4
    expect(finalSession!.messages.length).toBe(4);
    expect(finalSession!.messages[0].content).toBe("REST message 1");
    expect(finalSession!.messages[1].content).toBe("REST reply: REST message 1");
    expect(finalSession!.messages[2].content).toBe("WS subsequent turn");
    expect(finalSession!.messages[3].content).toBe("WS reply: WS subsequent turn");

    try {
      fs.unlinkSync(tempKeyPath);
    } catch {}
  });

  it("rejects concurrent REST turn with 409 when WS stream is in-flight on the same session", async () => {
    const tempKeyPath = path.join(
      os.tmpdir(),
      `seepient-test-sw2-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
    );
    process.env.SEEPIENT_API_KEYS_FILE = tempKeyPath;
    const k1 = generateApiKey(["agent:run", "admin"], { filePath: tempKeyPath });
    const key1 = k1.rawKey;
    const key1Hash = hashKey(key1);

    const backend = new MemoryPersistenceBackend();
    const sessionManager = new ServerSessionManager({ backend });
    const session = await sessionManager.createSession(key1, { id: "ws-first-session" });

    let finishWsStream!: () => void;
    const wsCtx: WebSocketHandlerContext = {
      registry: createConnectionRegistry(),
      sessionManager,
      streamText: (options) => {
        finishWsStream = () => {
          options.onDone({
            text: "WS stream done",
            usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10, cost: 0 },
            finishReason: "stop",
          });
        };
      },
      listModels: () => ({}),
      listSkills: () => [],
    };

    const restCtx: RestHandlerContext = {
      version: "0.7.0",
      startTime: Date.now(),
      sessionManager,
      generateText: async (opts) => ({
        text: "REST reply: " + opts.message,
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

    // 1. Start WS turn on ws-first-session
    const { ws } = createMockWs();
    const state: ConnectionState = {
      sessionId: null,
      activeChats: new Set(),
      apiKeyHash: key1Hash,
      apiKey: {
        keyHash: key1Hash,
        rawKey: key1,
        key: key1,
        scopes: ["agent:run"],
        created: new Date().toISOString(),
        label: "test",
      },
    } as any;

    handleChat(
      ws,
      { type: "chat", id: "ws-m1", message: "WS msg 1", sessionId: session.id },
      state,
      wsCtx,
    );
    await new Promise((r) => setTimeout(r, 10));

    // 2. While WS is in-flight, a REST turn on the SAME session arrives
    const req = createMockReqRes(
      "POST",
      "/v1/chat",
      {
        authorization: `Bearer ${key1}`,
        "content-type": "application/json",
      },
      JSON.stringify({ message: "REST concurrent attempt", sessionId: session.id }),
    );

    await new Promise<void>((resolve) => {
      req.res.on("finish", resolve);
      restHandler(req.req, req.res);
    });

    // REST must be rejected with 409 Conflict and REQUEST_IN_FLIGHT code
    expect(req.res.statusCode).toBe(409);
    const parsedBody = JSON.parse(req.res.body);
    expect(parsedBody.error?.code).toBe("REQUEST_IN_FLIGHT");

    // 3. Complete WS stream
    finishWsStream();
    await new Promise((r) => setTimeout(r, 10));

    // 4. Subsequent REST call now succeeds
    const req2 = createMockReqRes(
      "POST",
      "/v1/chat",
      {
        authorization: `Bearer ${key1}`,
        "content-type": "application/json",
      },
      JSON.stringify({ message: "REST after WS", sessionId: session.id }),
    );

    await new Promise<void>((resolve) => {
      req2.res.on("finish", resolve);
      restHandler(req2.req, req2.res);
    });
    expect(req2.res.statusCode).toBe(200);

    try {
      fs.unlinkSync(tempKeyPath);
    } catch {}
  });
});
