import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import { createRestHandler, type RestHandlerContext } from "../http/rest.js";
import { ServerSessionManager } from "../http/session-store.js";
import { MemoryPersistenceBackend } from "../../domain/sessions/session-store.js";
import { generateApiKey } from "../auth/auth.js";
import { handleChat, handleAbort } from "../ws/chat.js";
import { handleResume } from "../ws/session-control.js";
import { createConnectionRegistry } from "../ws/connection-registry.js";
import type { ChatMessage, ConnectionState, WebSocketHandlerContext, AbortMessage, ResumeMessage } from "../ws/ws-types.js";
import { parseBody } from "../http/provider-management/http-util.js";
import { PayloadTooLargeError } from "../http/body.js";

function createMockReq(
  method: string,
  url: string,
  headers: Record<string, string> = {},
  bodyChunks: Buffer[] = [],
) {
  const req = new EventEmitter() as any;
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.socket = { remoteAddress: "127.0.0.1" };
  req.pause = vi.fn();

  setTimeout(() => {
    for (const chunk of bodyChunks) {
      req.emit("data", chunk);
    }
    req.emit("end");
  }, 5);

  return req;
}

function createMockRes() {
  const res = new EventEmitter() as any;
  res.statusCode = 200;
  res.headers = {} as Record<string, string>;
  res.body = "";
  res.setHeader = function (k: string, v: string) {
    this.headers[k.toLowerCase()] = v;
  };
  res.getHeader = function (k: string) {
    return this.headers[k.toLowerCase()];
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
  return res;
}

describe("T033 — Cap Bundle & Parity (FR-029)", () => {
  let tempKeyPath: string;
  let rawKey: string;
  const origEnvMaxSteps = process.env.SEEPIENT_MAX_STEPS;
  const origKeyFile = process.env.SEEPIENT_API_KEYS_FILE;

  beforeEach(() => {
    tempKeyPath = path.join(
      os.tmpdir(),
      `seepient-t033-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
    );
    process.env.SEEPIENT_API_KEYS_FILE = tempKeyPath;
    const keyEntry = generateApiKey(["agent:run", "agent:read", "admin", "provider:admin", "provider:read"], {
      filePath: tempKeyPath,
    });
    rawKey = keyEntry.rawKey;
    delete process.env.SEEPIENT_MAX_STEPS;
  });

  afterEach(() => {
    if (origEnvMaxSteps !== undefined) {
      process.env.SEEPIENT_MAX_STEPS = origEnvMaxSteps;
    } else {
      delete process.env.SEEPIENT_MAX_STEPS;
    }
    if (origKeyFile !== undefined) {
      process.env.SEEPIENT_API_KEYS_FILE = origKeyFile;
    } else {
      delete process.env.SEEPIENT_API_KEYS_FILE;
    }
  });

  describe("REST maxSteps clamping & echo", () => {
    it("clamps maxSteps 10⁶ to default server.maxSteps (100) and echoes effective value", async () => {
      let passedMaxSteps: number | undefined;
      const generateText = vi.fn().mockImplementation(async (opts: any) => {
        passedMaxSteps = opts.maxSteps;
        return {
          text: "echo reply",
          toolCalls: [],
          usage: { promptTokens: 5, completionTokens: 10, totalTokens: 15 },
          finishReason: "stop",
        };
      });

      const sessionManager = new ServerSessionManager({ backend: new MemoryPersistenceBackend() });
      const ctx: RestHandlerContext = {
        sessionManager,
        generateText,
        listModels: () => ({}),
        listSkills: () => [],
        version: "0.8.0",
        startTime: Date.now(),
      };

      const handler = createRestHandler(ctx);
      const req = createMockReq(
        "POST",
        "/v1/chat",
        {
          authorization: `Bearer ${rawKey}`,
          "content-type": "application/json",
        },
        [Buffer.from(JSON.stringify({ message: "hello", maxSteps: 1_000_000 }))],
      );
      const res = createMockRes();

      await new Promise<void>((resolve) => {
        res.on("finish", resolve);
        handler(req, res);
      });

      expect(res.statusCode).toBe(200);
      expect(passedMaxSteps).toBe(100);

      const parsed = JSON.parse(res.body);
      expect(parsed.effectiveMaxSteps).toBe(100);
      expect(parsed.maxSteps).toBe(100);
      expect(parsed.text).toBe("echo reply");
    });

    it("does not echo effectiveMaxSteps if client maxSteps was not clamped", async () => {
      const generateText = vi.fn().mockResolvedValue({
        text: "fine",
        toolCalls: [],
        usage: { promptTokens: 5, completionTokens: 10, totalTokens: 15 },
        finishReason: "stop",
      });

      const sessionManager = new ServerSessionManager({ backend: new MemoryPersistenceBackend() });
      const ctx: RestHandlerContext = {
        sessionManager,
        generateText,
        listModels: () => ({}),
        listSkills: () => [],
        version: "0.8.0",
        startTime: Date.now(),
      };

      const handler = createRestHandler(ctx);
      const req = createMockReq(
        "POST",
        "/v1/chat",
        {
          authorization: `Bearer ${rawKey}`,
          "content-type": "application/json",
        },
        [Buffer.from(JSON.stringify({ message: "hello", maxSteps: 5 }))],
      );
      const res = createMockRes();

      await new Promise<void>((resolve) => {
        res.on("finish", resolve);
        handler(req, res);
      });

      expect(res.statusCode).toBe(200);
      const parsed = JSON.parse(res.body);
      expect(parsed.effectiveMaxSteps).toBeUndefined();
    });

    it("respects SEEPIENT_MAX_STEPS environment variable", async () => {
      process.env.SEEPIENT_MAX_STEPS = "25";

      let passedMaxSteps: number | undefined;
      const generateText = vi.fn().mockImplementation(async (opts: any) => {
        passedMaxSteps = opts.maxSteps;
        return {
          text: "env reply",
          toolCalls: [],
          usage: { promptTokens: 5, completionTokens: 10, totalTokens: 15 },
          finishReason: "stop",
        };
      });

      const sessionManager = new ServerSessionManager({ backend: new MemoryPersistenceBackend() });
      const ctx: RestHandlerContext = {
        sessionManager,
        generateText,
        listModels: () => ({}),
        listSkills: () => [],
        version: "0.8.0",
        startTime: Date.now(),
      };

      const handler = createRestHandler(ctx);
      const req = createMockReq(
        "POST",
        "/v1/chat",
        {
          authorization: `Bearer ${rawKey}`,
          "content-type": "application/json",
        },
        [Buffer.from(JSON.stringify({ message: "hello", maxSteps: 50 }))],
      );
      const res = createMockRes();

      await new Promise<void>((resolve) => {
        res.on("finish", resolve);
        handler(req, res);
      });

      expect(res.statusCode).toBe(200);
      expect(passedMaxSteps).toBe(25);
      const parsed = JSON.parse(res.body);
      expect(parsed.effectiveMaxSteps).toBe(25);
    });
  });

  describe("WS maxSteps clamping & onDone echo", () => {
    it("clamps maxSteps 10⁶ to 100 and echoes effectiveMaxSteps in done frame", async () => {
      const sentFrames: any[] = [];
      const mockWs = {
        readyState: 1,
        send: vi.fn((data: string) => sentFrames.push(JSON.parse(data))),
      } as any;

      let passedMaxSteps: number | undefined;
      const ctx: WebSocketHandlerContext = {
        registry: createConnectionRegistry(),
        sessionManager: new ServerSessionManager({ backend: new MemoryPersistenceBackend() }),
        streamText: vi.fn().mockImplementation(async (opts: any) => {
          passedMaxSteps = opts.maxSteps;
          opts.onText("Hello stream");
          opts.onDone({
            text: "Hello stream",
            usage: { promptTokens: 1, completionTokens: 2, cost: 0 },
            finishReason: "stop",
          });
        }),
        listModels: () => ({}),
        listSkills: () => [],
      };

      const state: ConnectionState = {
        sessionId: null,
        activeChats: new Set(),
        activeProvider: null,
        activeModel: null,
        apiKeyHash: "hash123",
        apiKey: {
          keyHash: "hash123",
          label: "test",
          scopes: ["agent:run"],
          created: new Date().toISOString(),
        },
      };

      const msg: ChatMessage = {
        type: "chat",
        id: "chat-req-1",
        message: "hello",
        options: { maxSteps: 1_000_000 },
      };

      await handleChat(mockWs, msg, state, ctx);

      expect(passedMaxSteps).toBe(100);

      const doneFrame = sentFrames.find((f) => f.type === "done");
      expect(doneFrame).toBeDefined();
      expect(doneFrame.effectiveMaxSteps).toBe(100);
      expect(doneFrame.maxSteps).toBe(100);
    });
  });

  describe("WS error frames carry clientMsgId", () => {
    it("includes clientMsgId in forbidden error frame", async () => {
      const sentFrames: any[] = [];
      const mockWs = {
        readyState: 1,
        send: vi.fn((data: string) => sentFrames.push(JSON.parse(data))),
      } as any;

      const ctx: WebSocketHandlerContext = {
        registry: createConnectionRegistry(),
        sessionManager: new ServerSessionManager({ backend: new MemoryPersistenceBackend() }),
        streamText: vi.fn(),
        listModels: () => ({}),
        listSkills: () => [],
      };

      const state: ConnectionState = {
        sessionId: null,
        activeChats: new Set(),
        activeProvider: null,
        activeModel: null,
        apiKeyHash: "hash123",
        apiKey: {
          keyHash: "hash123",
          label: "test",
          scopes: ["agent:read"],
          created: new Date().toISOString(),
        },
      };

      const msg: ChatMessage = {
        type: "chat",
        id: "client-custom-id-99",
        message: "hello",
      };

      await handleChat(mockWs, msg, state, ctx);

      const errorFrame = sentFrames.find((f) => f.type === "error");
      expect(errorFrame).toBeDefined();
      expect(errorFrame.code).toBe("FORBIDDEN");
      expect(errorFrame.clientMsgId).toBe("client-custom-id-99");
    });

    it("includes clientMsgId in validation error frame", async () => {
      const sentFrames: any[] = [];
      const mockWs = {
        readyState: 1,
        send: vi.fn((data: string) => sentFrames.push(JSON.parse(data))),
      } as any;

      const ctx: WebSocketHandlerContext = {
        registry: createConnectionRegistry(),
        sessionManager: new ServerSessionManager({ backend: new MemoryPersistenceBackend() }),
        streamText: vi.fn(),
        listModels: () => ({}),
        listSkills: () => [],
      };

      const state: ConnectionState = {
        sessionId: null,
        activeChats: new Set(),
        activeProvider: null,
        activeModel: null,
        apiKeyHash: "hash123",
        apiKey: {
          keyHash: "hash123",
          label: "test",
          scopes: ["agent:run"],
          created: new Date().toISOString(),
        },
      };

      const msg: ChatMessage = {
        type: "chat",
        id: "client-invalid-skills",
        message: "hello",
        options: { skills: "not-an-array" as any },
      };

      await handleChat(mockWs, msg, state, ctx);

      const errorFrame = sentFrames.find((f) => f.type === "error");
      expect(errorFrame).toBeDefined();
      expect(errorFrame.code).toBe("VALIDATION_ERROR");
      expect(errorFrame.clientMsgId).toBe("client-invalid-skills");
    });

    it("includes clientMsgId in stream error frame", async () => {
      const sentFrames: any[] = [];
      const mockWs = {
        readyState: 1,
        send: vi.fn((data: string) => sentFrames.push(JSON.parse(data))),
      } as any;

      const ctx: WebSocketHandlerContext = {
        registry: createConnectionRegistry(),
        sessionManager: new ServerSessionManager({ backend: new MemoryPersistenceBackend() }),
        streamText: vi.fn().mockImplementation((opts: any) => {
          opts.onError({ code: "STREAM_ERROR", message: "Model timeout" });
        }),
        listModels: () => ({}),
        listSkills: () => [],
      };

      const state: ConnectionState = {
        sessionId: null,
        activeChats: new Set(),
        activeProvider: null,
        activeModel: null,
        apiKeyHash: "hash123",
        apiKey: {
          keyHash: "hash123",
          label: "test",
          scopes: ["agent:run"],
          created: new Date().toISOString(),
        },
      };

      const msg: ChatMessage = {
        type: "chat",
        id: "client-stream-err",
        message: "hello",
      };

      await handleChat(mockWs, msg, state, ctx);

      const errorFrame = sentFrames.find((f) => f.type === "error");
      expect(errorFrame).toBeDefined();
      expect(errorFrame.code).toBe("STREAM_ERROR");
      expect(errorFrame.clientMsgId).toBe("client-stream-err");
    });

    it("includes clientMsgId in abort error frame", () => {
      const sentFrames: any[] = [];
      const mockWs = {
        readyState: 1,
        send: vi.fn((data: string) => sentFrames.push(JSON.parse(data))),
      } as any;

      const controller = new AbortController();
      const state: ConnectionState = {
        sessionId: null,
        activeChats: new Set([controller]),
        activeProvider: null,
        activeModel: null,
        apiKeyHash: "hash123",
      };

      const msg: AbortMessage = {
        type: "abort",
        id: "abort-req-42",
      };

      handleAbort(mockWs, msg, state);

      const errorFrame = sentFrames.find((f) => f.type === "error");
      expect(errorFrame).toBeDefined();
      expect(errorFrame.code).toBe("ABORTED");
      expect(errorFrame.clientMsgId).toBe("abort-req-42");
    });

    it("includes clientMsgId in session resume error frame", async () => {
      const sentFrames: any[] = [];
      const mockWs = {
        readyState: 1,
        send: vi.fn((data: string) => sentFrames.push(JSON.parse(data))),
      } as any;

      const ctx: WebSocketHandlerContext = {
        registry: createConnectionRegistry(),
        sessionManager: new ServerSessionManager({ backend: new MemoryPersistenceBackend() }),
        streamText: vi.fn(),
        listModels: () => ({}),
        listSkills: () => [],
      };

      const state: ConnectionState = {
        sessionId: null,
        activeChats: new Set(),
        activeProvider: null,
        activeModel: null,
        apiKeyHash: "hash123",
        apiKey: {
          keyHash: "hash123",
          label: "test",
          scopes: ["agent:read"],
          created: new Date().toISOString(),
        },
      };

      const msg: ResumeMessage = {
        type: "resume",
        id: "resume-msg-77",
        sessionId: "non-existent-session",
      };

      await handleResume(mockWs, msg, state, ctx);

      const errorFrame = sentFrames.find((f) => f.type === "error");
      expect(errorFrame).toBeDefined();
      expect(errorFrame.code).toBe("SESSION_NOT_FOUND");
      expect(errorFrame.clientMsgId).toBe("resume-msg-77");
    });
  });

  describe("Provider-management 413 parity & pause-and-respond", () => {
    it("pauses req and rejects with PayloadTooLargeError on chunk overflow without calling req.destroy", async () => {
      const req = createMockReq("POST", "/v1/models/resolve", {
        authorization: `Bearer ${rawKey}`,
        "content-type": "application/json",
      });
      req.destroy = vi.fn();

      const parsePromise = parseBody(req, 100);

      req.emit("data", Buffer.alloc(80, "a"));
      req.emit("data", Buffer.alloc(80, "b"));

      await expect(parsePromise).rejects.toThrow(PayloadTooLargeError);
      expect(req.pause).toHaveBeenCalled();
      expect(req.destroy).not.toHaveBeenCalled();
    });

    it("rejects immediately on Content-Length header overflow without calling req.destroy", async () => {
      const req = createMockReq("POST", "/v1/models/resolve", {
        authorization: `Bearer ${rawKey}`,
        "content-type": "application/json",
        "content-length": "2048",
      });
      req.destroy = vi.fn();

      const parsePromise = parseBody(req, 1024);

      await expect(parsePromise).rejects.toThrow(PayloadTooLargeError);
      expect(req.pause).toHaveBeenCalled();
      expect(req.destroy).not.toHaveBeenCalled();
    });
  });
});
