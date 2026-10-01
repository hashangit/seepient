import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { createRestHandler, type RestHandlerContext } from "../rest.js";
import { ServerSessionManager } from "../session-store.js";
import { FilePersistenceBackend, MemoryPersistenceBackend } from "../../../domain/sessions/session-store.js";
import { generateApiKey } from "../../auth/auth.js";

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

describe("FR-030: Durable Session Listing (T034)", () => {
  let tempKeyPath: string;
  let tempSessionDir: string;
  let key1: string;
  let key2: string;

  beforeEach(async () => {
    tempKeyPath = path.join(
      os.tmpdir(),
      `seepient-fr030-keys-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
    );
    tempSessionDir = path.join(
      os.tmpdir(),
      `seepient-fr030-sessions-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    process.env.SEEPIENT_API_KEYS_FILE = tempKeyPath;

    const k1 = generateApiKey(["agent:run", "agent:read"], { filePath: tempKeyPath });
    const k2 = generateApiKey(["agent:run", "agent:read"], { filePath: tempKeyPath });
    key1 = k1.rawKey;
    key2 = k2.rawKey;
  });

  afterEach(async () => {
    try {
      await fs.rm(tempKeyPath, { force: true });
      await fs.rm(tempSessionDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("restart scenario: sessions listed after server restart from disk with ownership enforced", async () => {
    // 1. Initial server instance writes session to disk via FilePersistenceBackend
    const backend1 = new FilePersistenceBackend(tempSessionDir);
    const sessionManager1 = new ServerSessionManager({ backend: backend1 });
    const s1 = await sessionManager1.createSession(key1, { provider: "openai", model: "gpt-4o" });

    sessionManager1.addMessage(s1.id, {
      id: "m1",
      role: "user",
      content: "Hello from user turn 1",
      timestamp: Date.now(),
    });
    sessionManager1.addMessage(s1.id, {
      id: "m2",
      role: "assistant",
      content: "Hello from assistant",
      timestamp: Date.now(),
    });

    // Wait briefly for file write
    await new Promise((resolve) => setTimeout(resolve, 50));

    // 2. Simulate server restart: new ServerSessionManager with fresh memory, pointing to same disk storage
    const backend2 = new FilePersistenceBackend(tempSessionDir);
    const sessionManager2 = new ServerSessionManager({ backend: backend2 });

    const ctx: RestHandlerContext = {
      sessionManager: sessionManager2,
      generateText: async () => ({ text: "ok" } as any),
      listModels: () => ({}),
      listSkills: () => [],
      version: "0.8.0",
      startTime: Date.now(),
    };
    const handler = createRestHandler(ctx);

    // 3. GET /v1/sessions for key1 finds the persisted session
    const { req: req1, res: res1 } = createMockReqRes("GET", "/v1/sessions", {
      authorization: `Bearer ${key1}`,
    });
    await new Promise<void>((resolve) => {
      res1.on("finish", resolve);
      handler(req1, res1);
    });

    expect(res1.statusCode).toBe(200);
    const body1 = JSON.parse(res1.body);
    expect(body1.source).toBeUndefined(); // durable, not memory-resident fallback
    const sessions1 = body1.sessions;
    expect(Array.isArray(sessions1)).toBe(true);
    expect(sessions1.length).toBe(1);

    const summary = sessions1[0];
    expect(summary.id).toBe(s1.id);
    expect(summary.messageCount).toBe(2);
    expect(summary.provider).toBe("openai");
    expect(summary.model).toBe("gpt-4o");
    expect((summary as any).messages).toBeUndefined(); // message bodies are not loaded

    // 4. GET /v1/sessions for foreign key2 does NOT see key1's session
    const { req: req2, res: res2 } = createMockReqRes("GET", "/v1/sessions", {
      authorization: `Bearer ${key2}`,
    });
    await new Promise<void>((resolve) => {
      res2.on("finish", resolve);
      handler(req2, res2);
    });

    expect(res2.statusCode).toBe(200);
    const body2 = JSON.parse(res2.body);
    expect(body2.sessions).toEqual([]);
  });

  it("memory backend reports source: 'memory' so empty or resident-only post-restart is explained", async () => {
    const backend = new MemoryPersistenceBackend();
    const sessionManager = new ServerSessionManager({ backend });
    const s1 = await sessionManager.createSession(key1, { provider: "anthropic", model: "claude-3-5-sonnet" });

    const ctx: RestHandlerContext = {
      sessionManager,
      generateText: async () => ({ text: "ok" } as any),
      listModels: () => ({}),
      listSkills: () => [],
      version: "0.8.0",
      startTime: Date.now(),
    };
    const handler = createRestHandler(ctx);

    const { req, res } = createMockReqRes("GET", "/v1/sessions", {
      authorization: `Bearer ${key1}`,
    });
    await new Promise<void>((resolve) => {
      res.on("finish", resolve);
      handler(req, res);
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.source).toBe("memory");
    expect(body.sessions.length).toBe(1);
    expect(body.sessions[0].id).toBe(s1.id);

    // Simulate restart with fresh memory backend -> 0 sessions, still explains source: "memory"
    const freshManager = new ServerSessionManager({ backend: new MemoryPersistenceBackend() });
    const freshCtx: RestHandlerContext = {
      ...ctx,
      sessionManager: freshManager,
    };
    const freshHandler = createRestHandler(freshCtx);

    const { req: reqFresh, res: resFresh } = createMockReqRes("GET", "/v1/sessions", {
      authorization: `Bearer ${key1}`,
    });
    await new Promise<void>((resolve) => {
      resFresh.on("finish", resolve);
      freshHandler(reqFresh, resFresh);
    });

    expect(resFresh.statusCode).toBe(200);
    const freshBody = JSON.parse(resFresh.body);
    expect(freshBody.source).toBe("memory");
    expect(freshBody.sessions).toEqual([]);
  });
});
