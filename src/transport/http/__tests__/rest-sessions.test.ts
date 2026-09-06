import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRestHandler } from "../rest.js";
import { ServerSessionManager, hashKey } from "../session-store.js";
import { MemoryPersistenceBackend } from "../../../domain/sessions/session-store.js";
import { generateApiKey } from "../../auth/auth.js";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";

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

describe("REST Sessions & Chat Resume (Spec 021-2 / FR-005, FR-006)", () => {
  let tempKeyPath: string;
  let key1: string;
  let key2: string;
  let sessionManager: ServerSessionManager;
  let handler: any;

  beforeEach(async () => {
    tempKeyPath = path.join(
      os.tmpdir(),
      `seepient-test-keys-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
    );
    process.env.SEEPIENT_API_KEYS_FILE = tempKeyPath;

    const k1 = generateApiKey(["agent:run", "admin"], { filePath: tempKeyPath });
    const k2 = generateApiKey(["agent:run", "admin"], { filePath: tempKeyPath });
    key1 = k1.rawKey;
    key2 = k2.rawKey;

    sessionManager = new ServerSessionManager({ backend: new MemoryPersistenceBackend() });

    const ctx = {
      version: "0.7.0",
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

    handler = createRestHandler(ctx);
  });

  afterEach(() => {
    try {
      fs.unlinkSync(tempKeyPath);
    } catch {}
  });

  it("GET /v1/sessions lists caller sessions as SessionSummary without message bodies", async () => {
    // Create 2 sessions for key1 and 1 for key2
    const s1 = await sessionManager.createSession(key1, { provider: "openai", model: "gpt-4o" });
    const s2 = await sessionManager.createSession(key1, { provider: "anthropic", model: "claude-3-5-sonnet" });
    await sessionManager.createSession(key2, { provider: "google", model: "gemini-2.0" });

    sessionManager.addMessage(s1.id, { id: "1", role: "user", content: "Hi", timestamp: Date.now() });

    const { req, res } = createMockReqRes("GET", "/v1/sessions", {
      authorization: `Bearer ${key1}`,
    });

    await new Promise<void>((resolve) => {
      res.on("finish", resolve);
      handler(req, res);
    });

    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(2);

    const ids = data.map((d: any) => d.id);
    expect(ids).toContain(s1.id);
    expect(ids).toContain(s2.id);

    // Assert SessionSummary shape (no message bodies)
    const summary = data.find((d: any) => d.id === s1.id);
    expect(summary.id).toBe(s1.id);
    expect(summary.messageCount).toBe(1);
    expect(summary.provider).toBe("openai");
    expect(summary.model).toBe("gpt-4o");
    expect(summary.messages).toBeUndefined();
  });

  it("POST /v1/chat resumes session when sessionId is provided and persists messages", async () => {
    const session = await sessionManager.createSession(key1);

    const body = JSON.stringify({
      message: "Hello again",
      sessionId: session.id,
    });

    const { req, res } = createMockReqRes("POST", "/v1/chat", {
      authorization: `Bearer ${key1}`,
      "content-type": "application/json",
    }, body);

    await new Promise<void>((resolve) => {
      res.on("finish", resolve);
      handler(req, res);
    });

    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.sessionId).toBe(session.id);
    expect(data.text).toBe("Echo: Hello again");

    // Check that user and assistant messages were persisted through sessionManager
    const updated = await sessionManager.getSession(session.id, (sessionManager as any).sessions.get(session.id)!.apiKeyHash);
    expect(updated).not.toBeNull();
    expect(updated!.messages.length).toBe(2);
    expect(updated!.messages[0].role).toBe("user");
    expect(updated!.messages[0].content).toBe("Hello again");
    expect(updated!.messages[1].role).toBe("assistant");
    expect(updated!.messages[1].content).toBe("Echo: Hello again");
  });

  it("POST /v1/chat passes prior turn history excluding current turn message to generateText (W005)", async () => {
    let lastGenerateTextOpts: any = null;
    const ctx = {
      version: "0.7.0",
      startTime: Date.now(),
      sessionManager,
      generateText: async (opts: any) => {
        lastGenerateTextOpts = opts;
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
    const testHandler = createRestHandler(ctx);

    const session = await sessionManager.createSession(key1);

    // Turn 1
    const { req: req1, res: res1 } = createMockReqRes("POST", "/v1/chat", {
      authorization: `Bearer ${key1}`,
      "content-type": "application/json",
    }, JSON.stringify({ message: "Turn 1 msg", sessionId: session.id }));
    await new Promise<void>((resolve) => {
      res1.on("finish", resolve);
      testHandler(req1, res1);
    });
    expect(res1.statusCode).toBe(200);
    expect(lastGenerateTextOpts.history).toEqual([]);

    // Turn 2
    const { req: req2, res: res2 } = createMockReqRes("POST", "/v1/chat", {
      authorization: `Bearer ${key1}`,
      "content-type": "application/json",
    }, JSON.stringify({ message: "Turn 2 msg", sessionId: session.id }));
    await new Promise<void>((resolve) => {
      res2.on("finish", resolve);
      testHandler(req2, res2);
    });
    expect(res2.statusCode).toBe(200);
    // History must contain turn 1 user + assistant, and NOT turn 2 user message
    expect(lastGenerateTextOpts.history.length).toBe(2);
    expect(lastGenerateTextOpts.history[0].content).toBe("Turn 1 msg");
    expect(lastGenerateTextOpts.history[0].role).toBe("user");
    expect(lastGenerateTextOpts.history[1].content).toBe("Echo: Turn 1 msg");
    expect(lastGenerateTextOpts.history[1].role).toBe("assistant");
    expect(lastGenerateTextOpts.message).toBe("Turn 2 msg");
  });

  it("POST /v1/chat returns 404 for unknown or foreign sessionId", async () => {
    const body = JSON.stringify({
      message: "Hello",
      sessionId: "00000000-0000-0000-0000-000000000000",
    });

    const { req, res } = createMockReqRes("POST", "/v1/chat", {
      authorization: `Bearer ${key1}`,
      "content-type": "application/json",
    }, body);

    await new Promise<void>((resolve) => {
      res.on("finish", resolve);
      handler(req, res);
    });

    expect(res.statusCode).toBe(404);
  });

  it("POST /v1/chat without sessionId is stateless (D1): no session created, no 429, no files saved", async () => {
    // Set low max sessions per key to ensure sessionless doesn't count against cap
    process.env.SEEPIENT_MAX_SESSIONS_PER_KEY = "5";
    const saveSpy = vi.spyOn((sessionManager as any).backend, "save");

    try {
      for (let i = 0; i < 10; i++) {
        const body = JSON.stringify({
          message: `Stateless message ${i}`,
        });

        const { req, res } = createMockReqRes(
          "POST",
          "/v1/chat",
          {
            authorization: `Bearer ${key1}`,
            "content-type": "application/json",
          },
          body,
        );

        await new Promise<void>((resolve) => {
          res.on("finish", resolve);
          handler(req, res);
        });

        expect(res.statusCode).toBe(200);
        const data = JSON.parse(res.body);
        expect(data.sessionId).toBeUndefined();
        expect(data.text).toBe(`Echo: Stateless message ${i}`);
      }

      // No sessions should be tracked for this key
      const summaries = sessionManager.getSessionsByKey(hashKey(key1));
      expect(summaries.length).toBe(0);

      // Backend save must not have been invoked
      expect(saveSpy).not.toHaveBeenCalled();
    } finally {
      delete process.env.SEEPIENT_MAX_SESSIONS_PER_KEY;
      saveSpy.mockRestore();
    }
  });
});
