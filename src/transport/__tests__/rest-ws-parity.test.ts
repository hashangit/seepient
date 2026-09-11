import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRestHandler } from "../http/rest.js";
import { ServerSessionManager, hashKey } from "../http/session-store.js";
import { MemoryPersistenceBackend } from "../../domain/sessions/session-store.js";
import { generateApiKey } from "../auth/auth.js";
import { handleConnection } from "../ws/ws-handlers.js";
import { createConnectionRegistry } from "../ws/connection-registry.js";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import type { WebSocket, WebSocketHandlerContext } from "../ws/ws-types.js";

function createMockReqRes(method: string, url: string, headers: Record<string, string> = {}, body?: string) {
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
  const handlers = new Map<string, (...args: any[]) => void>();
  const ws = {
    send: (data: string) => sent.push(JSON.parse(data)),
    readyState: 1,
    close: vi.fn(),
    ping: vi.fn(),
    on: (event: string, cb: (...args: any[]) => void) => {
      handlers.set(event, cb);
    },
  } as unknown as WebSocket;
  return { ws, sent, handlers };
}

describe("REST and WS adopt-or-create parity (FR-026)", () => {
  let tempKeyPath: string;
  let key1: string;
  let key2: string;
  let sessionManager: ServerSessionManager;
  let restHandler: any;
  let wsCtx: WebSocketHandlerContext;

  beforeEach(() => {
    tempKeyPath = path.join(
      os.tmpdir(),
      `seepient-parity-keys-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
    );
    process.env.SEEPIENT_API_KEYS_FILE = tempKeyPath;

    const k1 = generateApiKey(["agent:run", "agent:read", "admin"], { filePath: tempKeyPath });
    const k2 = generateApiKey(["agent:run", "agent:read"], { filePath: tempKeyPath });
    key1 = k1.rawKey!;
    key2 = k2.rawKey!;

    sessionManager = new ServerSessionManager({ backend: new MemoryPersistenceBackend() });

    const restCtx = {
      version: "0.8.0",
      startTime: Date.now(),
      sessionManager,
      generateText: async (opts: any) => {
        return {
          text: `Echo: ${opts.message}`,
          toolCalls: [],
          usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10, cost: 0 },
          finishReason: "stop",
        };
      },
      listModels: () => ({}),
      listSkills: () => [],
    } as any;

    restHandler = createRestHandler(restCtx);

    wsCtx = {
      registry: createConnectionRegistry(),
      sessionManager,
      streamText: async (opts: any) => {
        opts.onText?.(`Echo: ${opts.message}`);
        opts.onDone?.({
          text: `Echo: ${opts.message}`,
          usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10, cost: 0 },
          finishReason: "stop",
        });
      },
      listModels: () => ({}),
      listSkills: () => [],
    };
  });

  afterEach(() => {
    try {
      fs.unlinkSync(tempKeyPath);
    } catch {}
  });

  it("REST: fresh-id POST /v1/chat creates session, appears in listing, foreign probe is denied", async () => {
    const sessionId = "rest-adopt-session-" + Date.now();

    // 1. POST /v1/chat with fresh sessionId
    const { req: chatReq, res: chatRes } = createMockReqRes(
      "POST",
      "/v1/chat",
      {
        authorization: `Bearer ${key1}`,
        "content-type": "application/json",
      },
      JSON.stringify({ message: "Initial message", sessionId }),
    );

    await new Promise<void>((resolve) => {
      chatRes.on("finish", resolve);
      restHandler(chatReq, chatRes);
    });

    expect(chatRes.statusCode).toBe(200);
    const chatData = JSON.parse(chatRes.body);
    expect(chatData.sessionId).toBe(sessionId);

    // 2. GET /v1/sessions for key1 includes the session
    const { req: listReq, res: listRes } = createMockReqRes(
      "GET",
      "/v1/sessions",
      { authorization: `Bearer ${key1}` },
    );

    await new Promise<void>((resolve) => {
      listRes.on("finish", resolve);
      restHandler(listReq, listRes);
    });

    expect(listRes.statusCode).toBe(200);
    const body = JSON.parse(listRes.body);
    const sessions = Array.isArray(body) ? body : body.sessions;
    expect(sessions.some((s: any) => s.id === sessionId)).toBe(true);

    // 3. GET /v1/sessions/:id with foreign key2 returns 404
    const { req: getForeignReq, res: getForeignRes } = createMockReqRes(
      "GET",
      `/v1/sessions/${sessionId}`,
      { authorization: `Bearer ${key2}` },
    );

    await new Promise<void>((resolve) => {
      getForeignRes.on("finish", resolve);
      restHandler(getForeignReq, getForeignRes);
    });

    expect(getForeignRes.statusCode).toBe(404);

    // 4. POST /v1/chat with foreign key2 targeting key1's session returns 403
    const { req: probeReq, res: probeRes } = createMockReqRes(
      "POST",
      "/v1/chat",
      {
        authorization: `Bearer ${key2}`,
        "content-type": "application/json",
      },
      JSON.stringify({ message: "Hostile probe", sessionId }),
    );

    await new Promise<void>((resolve) => {
      probeRes.on("finish", resolve);
      restHandler(probeReq, probeRes);
    });

    expect(probeRes.statusCode).toBe(403);
    const probeData = JSON.parse(probeRes.body);
    expect(probeData.error.code).toBe("FORBIDDEN");
  });

  it("WS: fresh-id chat creates session, appears in listing, foreign probe is denied", async () => {
    const sessionId = "ws-adopt-session-" + Date.now();
    const { ws, sent, handlers } = createMockWs();

    handleConnection(ws, { headers: { authorization: `Bearer ${key1}` } } as any, wsCtx);
    const onMessage = handlers.get("message")!;

    // 1. Send chat message with fresh sessionId
    onMessage(Buffer.from(JSON.stringify({
      type: "chat",
      id: "ws-chat-msg-1",
      message: "Hello over WS",
      sessionId,
    })));

    await new Promise((r) => setTimeout(r, 40));

    const ack = sent.find((m) => m.type === "ack" && m.clientMsgId === "ws-chat-msg-1");
    expect(ack).toBeDefined();

    const done = sent.find((m) => m.type === "done");
    expect(done).toBeDefined();

    // 2. GET /v1/sessions for key1 includes the session created over WS
    const { req: listReq, res: listRes } = createMockReqRes(
      "GET",
      "/v1/sessions",
      { authorization: `Bearer ${key1}` },
    );

    await new Promise<void>((resolve) => {
      listRes.on("finish", resolve);
      restHandler(listReq, listRes);
    });

    expect(listRes.statusCode).toBe(200);
    const body2 = JSON.parse(listRes.body);
    const sessions = Array.isArray(body2) ? body2 : body2.sessions;
    expect(sessions.some((s: any) => s.id === sessionId)).toBe(true);

    // 3. WS connection with foreign key2 attempting to use sessionId is denied with FORBIDDEN
    const { ws: ws2, sent: sent2, handlers: handlers2 } = createMockWs();
    handleConnection(ws2, { headers: { authorization: `Bearer ${key2}` } } as any, wsCtx);
    const onMessage2 = handlers2.get("message")!;

    onMessage2(Buffer.from(JSON.stringify({
      type: "chat",
      id: "ws-probe-msg-2",
      message: "Probe over WS",
      sessionId,
    })));

    await new Promise((r) => setTimeout(r, 40));

    const forbidden = sent2.find((m) => m.type === "error" && m.clientMsgId === "ws-probe-msg-2");
    expect(forbidden).toBeDefined();
    expect(forbidden.code).toBe("FORBIDDEN");
  });

  it("Cross-surface: session created via REST can be resumed via WS and vice-versa", async () => {
    // A. Create via REST
    const sessionId = "cross-surface-session-" + Date.now();
    const { req: r1, res: res1 } = createMockReqRes(
      "POST",
      "/v1/chat",
      {
        authorization: `Bearer ${key1}`,
        "content-type": "application/json",
      },
      JSON.stringify({ message: "Message from REST", sessionId }),
    );

    await new Promise<void>((resolve) => {
      res1.on("finish", resolve);
      restHandler(r1, res1);
    });
    expect(res1.statusCode).toBe(200);

    // B. Resume via WS under key1
    const { ws, sent, handlers } = createMockWs();
    handleConnection(ws, { headers: { authorization: `Bearer ${key1}` } } as any, wsCtx);
    const onMessage = handlers.get("message")!;

    onMessage(Buffer.from(JSON.stringify({
      type: "resume",
      id: "resume-req-1",
      sessionId,
    })));

    await new Promise((r) => setTimeout(r, 40));

    const resumed = sent.find((m) => m.type === "session_resumed");
    expect(resumed).toBeDefined();
    expect(resumed.sessionId).toBe(sessionId);
    expect(resumed.messages.length).toBe(2);
    expect(resumed.messages[0].content).toBe("Message from REST");
  });
});
