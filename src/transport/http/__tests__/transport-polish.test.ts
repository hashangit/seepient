import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { EventEmitter } from "node:events";
import { runSeepientServer } from "../index.js";
import { createRestHandler, type RestHandlerContext } from "../rest.js";
import { ServerSessionManager } from "../session-store.js";
import { MemoryPersistenceBackend } from "../../../domain/sessions/session-store.js";
import { SettingsManager } from "../../../domain/settings/settings-manager.js";
import { RateLimiter, globalRateLimiter } from "../rate-limit.js";
import { generateApiKey } from "../../auth/auth.js";
import { handleProbeProvider } from "../provider-management/catalog.js";
import { handleChat } from "../../ws/chat.js";
import type { ChatMessage, ConnectionState, WebSocketHandlerContext } from "../../ws/ws-types.js";
import { createConnectionRegistry } from "../../ws/connection-registry.js";

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

describe("Phase 5: Transport Polish (W024, W025, W026)", () => {
  const origCors = process.env.SEEPIENT_CORS_ORIGINS;
  const origMaxBody = process.env.SEEPIENT_MAX_BODY_BYTES;
  const origRpm = process.env.SEEPIENT_RATE_LIMIT_RPM;
  const origKeysFile = process.env.SEEPIENT_API_KEYS_FILE;

  let tempKeyPath: string;
  let rawKey: string;

  beforeEach(() => {
    tempKeyPath = path.join(
      os.tmpdir(),
      `seepient-polish-keys-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
    );
    process.env.SEEPIENT_API_KEYS_FILE = tempKeyPath;
    const keyEntry = generateApiKey(["agent:run", "admin", "provider:admin", "provider:read"], { filePath: tempKeyPath });
    rawKey = keyEntry.rawKey;
    globalRateLimiter.reset();
  });

  afterEach(() => {
    globalRateLimiter.reset();
    if (origCors !== undefined) process.env.SEEPIENT_CORS_ORIGINS = origCors;
    else delete process.env.SEEPIENT_CORS_ORIGINS;

    if (origMaxBody !== undefined) process.env.SEEPIENT_MAX_BODY_BYTES = origMaxBody;
    else delete process.env.SEEPIENT_MAX_BODY_BYTES;

    if (origRpm !== undefined) process.env.SEEPIENT_RATE_LIMIT_RPM = origRpm;
    else delete process.env.SEEPIENT_RATE_LIMIT_RPM;

    if (origKeysFile !== undefined) process.env.SEEPIENT_API_KEYS_FILE = origKeysFile;
    else delete process.env.SEEPIENT_API_KEYS_FILE;

    try {
      if (fs.existsSync(tempKeyPath)) fs.unlinkSync(tempKeyPath);
    } catch {
      // ignore
    }
  });

  // ── W024: CORS allow-all for "*" and Vary: Origin ─────────────────────────
  describe("W024: CORS allow-all and Vary: Origin", () => {
    it("SEEPIENT_CORS_ORIGINS='*' allows arbitrary origin and sets Vary: Origin", async () => {
      process.env.SEEPIENT_CORS_ORIGINS = "*";

      const server = await runSeepientServer({ listen: false,
        persist: new MemoryPersistenceBackend(),
      });

      const req = createMockReq("GET", "/v1/health", { origin: "https://my-app.example.com" });
      const res = createMockRes();

      await new Promise<void>((resolve) => {
        res.on("finish", resolve);
        server.emit("request", req, res);
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers["access-control-allow-origin"]).toBe("https://my-app.example.com");
      expect(res.headers["vary"]).toContain("Origin");
    });

    it("preflight OPTIONS with SEEPIENT_CORS_ORIGINS='*' responds with CORS and Vary: Origin", async () => {
      process.env.SEEPIENT_CORS_ORIGINS = "*";

      const server = await runSeepientServer({ listen: false,
        persist: new MemoryPersistenceBackend(),
      });

      const req = createMockReq("OPTIONS", "/v1/chat", {
        origin: "https://custom-ui.org",
        "access-control-request-method": "POST",
      });
      const res = createMockRes();

      await new Promise<void>((resolve) => {
        res.on("finish", resolve);
        server.emit("request", req, res);
      });

      expect(res.statusCode).toBe(204);
      expect(res.headers["access-control-allow-origin"]).toBe("https://custom-ui.org");
      expect(res.headers["vary"]).toContain("Origin");
    });

    it("specific origin allowlist allows matching origin and rejects non-matching", async () => {
      process.env.SEEPIENT_CORS_ORIGINS = "https://trusted.com, https://app.internal";

      const server = await runSeepientServer({ listen: false,
        persist: new MemoryPersistenceBackend(),
      });

      // Matching origin
      const req1 = createMockReq("GET", "/v1/health", { origin: "https://trusted.com" });
      const res1 = createMockRes();
      await new Promise<void>((resolve) => {
        res1.on("finish", resolve);
        server.emit("request", req1, res1);
      });
      expect(res1.headers["access-control-allow-origin"]).toBe("https://trusted.com");
      expect(res1.headers["vary"]).toContain("Origin");

      // Non-matching origin
      const req2 = createMockReq("GET", "/v1/health", { origin: "https://evil.com" });
      const res2 = createMockRes();
      await new Promise<void>((resolve) => {
        res2.on("finish", resolve);
        server.emit("request", req2, res2);
      });
      expect(res2.headers["access-control-allow-origin"]).toBeUndefined();
    });
  });

  // ── W025: Wire registered settings through settings-manager reads ──────────
  describe("W025: Settings-manager wire-through at server construction", () => {
    it("settings-file value for server.maxBodyBytes takes effect without env var", async () => {
      delete process.env.SEEPIENT_MAX_BODY_BYTES;

      // Injected settings manager with server.maxBodyBytes = 50
      const settingsManager = new SettingsManager({
        config: {
          server: {
            maxBodyBytes: 50,
          },
        },
      });

      const server = await runSeepientServer({ listen: false,
        settingsManager,
        persist: new MemoryPersistenceBackend(),
      });

      const payload = JSON.stringify({ message: "A".repeat(100) });
      const req = createMockReq(
        "POST",
        "/v1/chat",
        {
          authorization: `Bearer ${rawKey}`,
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(payload)),
        },
        [Buffer.from(payload)],
      );
      const res = createMockRes();

      await new Promise<void>((resolve) => {
        res.on("finish", resolve);
        server.emit("request", req, res);
      });

      expect(res.statusCode).toBe(413);
      const body = JSON.parse(res.body);
      expect(body.error?.code).toBe("PAYLOAD_TOO_LARGE");
    });

    it("settings-file value for server.rateLimitRpm takes effect without env var", async () => {
      delete process.env.SEEPIENT_RATE_LIMIT_RPM;

      // Injected settings manager with server.rateLimitRpm = 2
      const settingsManager = new SettingsManager({
        config: {
          server: {
            rateLimitRpm: 2,
          },
        },
      });

      const server = await runSeepientServer({ listen: false,
        settingsManager,
        persist: new MemoryPersistenceBackend(),
      });

      // 1st request -> ok
      const req1 = createMockReq("GET", "/v1/sessions", { authorization: `Bearer ${rawKey}` });
      const res1 = createMockRes();
      await new Promise<void>((r) => { res1.on("finish", r); server.emit("request", req1, res1); });
      expect(res1.statusCode).toBe(200);

      // 2nd request -> ok
      const req2 = createMockReq("GET", "/v1/sessions", { authorization: `Bearer ${rawKey}` });
      const res2 = createMockRes();
      await new Promise<void>((r) => { res2.on("finish", r); server.emit("request", req2, res2); });
      expect(res2.statusCode).toBe(200);

      // 3rd request -> 429
      const req3 = createMockReq("GET", "/v1/sessions", { authorization: `Bearer ${rawKey}` });
      const res3 = createMockRes();
      await new Promise<void>((r) => { res3.on("finish", r); server.emit("request", req3, res3); });
      expect(res3.statusCode).toBe(429);
      expect(res3.headers["retry-after"]).toBeDefined();
    });

    it("settings-file value for server.corsOrigins takes effect without env var", async () => {
      delete process.env.SEEPIENT_CORS_ORIGINS;

      const settingsManager = new SettingsManager({
        config: {
          server: {
            corsOrigins: "https://from-config.net",
          },
        },
      });

      const server = await runSeepientServer({ listen: false,
        settingsManager,
        persist: new MemoryPersistenceBackend(),
      });

      const reqAllowed = createMockReq("GET", "/v1/health", { origin: "https://from-config.net" });
      const resAllowed = createMockRes();
      await new Promise<void>((r) => { resAllowed.on("finish", r); server.emit("request", reqAllowed, resAllowed); });
      expect(resAllowed.headers["access-control-allow-origin"]).toBe("https://from-config.net");

      const reqDenied = createMockReq("GET", "/v1/health", { origin: "https://unknown.net" });
      const resDenied = createMockRes();
      await new Promise<void>((r) => { resDenied.on("finish", r); server.emit("request", reqDenied, resDenied); });
      expect(resDenied.headers["access-control-allow-origin"]).toBeUndefined();
    });
  });

  // ── W026: Observability gaps ───────────────────────────────────────────────
  describe("W026: Observability gaps", () => {
    it("429 rate limit carries Retry-After header", async () => {
      process.env.SEEPIENT_RATE_LIMIT_RPM = "1";

      const sessionManager = new ServerSessionManager({ backend: new MemoryPersistenceBackend() });
      const ctx: RestHandlerContext = {
        sessionManager,
        generateText: vi.fn().mockResolvedValue({ text: "ok", toolCalls: [] }),
        listModels: vi.fn().mockReturnValue({}),
        listSkills: vi.fn().mockReturnValue([]),
        version: "0.7.0",
        startTime: Date.now(),
        rateLimiter: new RateLimiter(1),
      };

      const handler = createRestHandler(ctx);

      // 1st request -> ok
      const req1 = createMockReq("GET", "/v1/sessions", { authorization: `Bearer ${rawKey}` });
      const res1 = createMockRes();
      await new Promise<void>((r) => { res1.on("finish", r); handler(req1, res1); });
      expect(res1.statusCode).toBe(200);

      // 2nd request -> 429 with Retry-After
      const req2 = createMockReq("GET", "/v1/sessions", { authorization: `Bearer ${rawKey}` });
      const res2 = createMockRes();
      await new Promise<void>((r) => { res2.on("finish", r); handler(req2, res2); });
      expect(res2.statusCode).toBe(429);
      expect(res2.headers["retry-after"]).toBeDefined();
      expect(Number(res2.headers["retry-after"])).toBeGreaterThan(0);
    });

    it("catalog.ts probe failures log request's requestId instead of a fresh UUID", async () => {
      const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

      const fakeReq = createMockReq("POST", "/v1/providers/test-prov/probe");
      fakeReq.requestId = "req-fixed-12345";

      const fakeRes = createMockRes();
      const mockRuntime = {
        createTurnSnapshot: vi.fn().mockResolvedValue({
          config: {
            providers: {
              "test-prov": {
                baseUrl: "http://127.0.0.1:1/nonexistent",
                credential: { type: "api-key" },
              },
            },
          },
        }),
        credentialStore: {
          resolve: vi.fn().mockResolvedValue({
            isResolvable: vi.fn().mockResolvedValue(true),
          }),
        },
      } as any;

      const key = { key: rawKey, scopes: ["provider:admin"] } as any;

      await handleProbeProvider(fakeReq, fakeRes, mockRuntime, key, "test-prov", true);

      const loggedLines = stdoutSpy.mock.calls
        .map(([c]) => {
          try { return JSON.parse(String(c)); } catch { return null; }
        })
        .filter(Boolean);

      const probeLog = loggedLines.find((l) => l.event === "probe");
      expect(probeLog).toBeDefined();
      expect(probeLog.requestId).toBe("req-fixed-12345");

      stdoutSpy.mockRestore();
    });

    it("chat.ts catch blocks emit ws_dispatch error lines", async () => {
      const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

      const mockWs = {
        readyState: 1, // OPEN
        send: vi.fn(),
      } as any;

      const msg: ChatMessage = {
        type: "chat",
        id: "client-msg-789",
        message: "hello",
      };

      const state: ConnectionState = {
        activeChats: new Set(),
        apiKeyHash: "hash123",
        apiKey: {
          keyHash: "hash123",
          scopes: ["agent:run"],
          created: new Date().toISOString(),
          label: "transport-polish-test",
        },
      } as any;

      const ctx: WebSocketHandlerContext = {
        registry: createConnectionRegistry(),
        sessionManager: new ServerSessionManager({ backend: new MemoryPersistenceBackend() }),
        streamText: vi.fn().mockRejectedValue(new Error("Simulated stream crash")),
        listModels: vi.fn().mockReturnValue({}),
        listSkills: vi.fn().mockReturnValue([]),
      };

      await handleChat(mockWs, msg, state, ctx);

      const loggedLines = stdoutSpy.mock.calls
        .map(([c]) => {
          try { return JSON.parse(String(c)); } catch { return null; }
        })
        .filter(Boolean);

      const wsDispatchError = loggedLines.find(
        (l) => l.event === "ws_dispatch" && l.level === "error",
      );
      expect(wsDispatchError).toBeDefined();
      expect(wsDispatchError.requestId).toBe("client-msg-789");
      expect(wsDispatchError.error).toBe("Simulated stream crash");

      stdoutSpy.mockRestore();
    });

    it("unhandled error in rest.ts does not call console.error", async () => {
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const sessionManager = new ServerSessionManager({ backend: new MemoryPersistenceBackend() });
      const ctx: RestHandlerContext = {
        sessionManager,
        generateText: vi.fn(),
        listModels: vi.fn().mockImplementation(() => {
          throw new Error("Simulated unhandled handler crash");
        }),
        listSkills: vi.fn().mockReturnValue([]),
        version: "0.7.0",
        startTime: Date.now(),
      };

      const handler = createRestHandler(ctx);

      const req = createMockReq("GET", "/v1/models", { authorization: `Bearer ${rawKey}` });
      const res = createMockRes();

      await new Promise<void>((resolve) => {
        res.on("finish", resolve);
        handler(req, res);
      });

      expect(res.statusCode).toBe(500);
      expect(consoleErrorSpy).not.toHaveBeenCalled();

      consoleErrorSpy.mockRestore();
    });
  });
});
