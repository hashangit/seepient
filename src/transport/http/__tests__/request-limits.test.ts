import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRestHandler, type RestHandlerContext } from "../rest.js";
import { ServerSessionManager } from "../session-store.js";
import { MemoryPersistenceBackend } from "../../../domain/sessions/session-store.js";
import { generateApiKey } from "../../auth/auth.js";
import { globalRateLimiter } from "../rate-limit.js";
import { EventEmitter } from "events";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import type { AddressInfo } from "node:net";
import { setupWebSocket, closeWebSocket } from "../../ws/websocket.js";
// @ts-expect-error — ws is an optional peer dependency without bundled types
import { WebSocket as WsClient } from "ws";

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

  setTimeout(() => {
    for (const chunk of bodyChunks) {
      req.emit("data", chunk);
    }
    req.emit("end");
  }, 10);

  return req;
}

function createMockRes() {
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
  return res;
}

describe("Transport Limits (Spec 021-2 / T019, T022, QS-7)", () => {
  const originalMaxBody = process.env.SEEPIENT_MAX_BODY_BYTES;
  const originalRpm = process.env.SEEPIENT_RATE_LIMIT_RPM;
  const originalKeysFile = process.env.SEEPIENT_API_KEYS_FILE;
  let tempKeyPath: string;
  let key1: string;
  let key2: string;

  beforeEach(() => {
    tempKeyPath = path.join(
      os.tmpdir(),
      `seepient-limits-keys-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
    );
    process.env.SEEPIENT_API_KEYS_FILE = tempKeyPath;
    const k1 = generateApiKey(["agent:run", "admin"], { filePath: tempKeyPath });
    const k2 = generateApiKey(["agent:run", "admin"], { filePath: tempKeyPath });
    key1 = k1.rawKey;
    key2 = k2.rawKey;
    globalRateLimiter.reset();
  });

  afterEach(() => {
    globalRateLimiter.reset();
    if (originalMaxBody !== undefined) process.env.SEEPIENT_MAX_BODY_BYTES = originalMaxBody;
    else delete process.env.SEEPIENT_MAX_BODY_BYTES;

    if (originalRpm !== undefined) process.env.SEEPIENT_RATE_LIMIT_RPM = originalRpm;
    else delete process.env.SEEPIENT_RATE_LIMIT_RPM;

    if (originalKeysFile !== undefined) process.env.SEEPIENT_API_KEYS_FILE = originalKeysFile;
    else delete process.env.SEEPIENT_API_KEYS_FILE;

    try {
      if (fs.existsSync(tempKeyPath)) fs.unlinkSync(tempKeyPath);
    } catch {
      // ignore
    }
  });

  describe("1. REST Body Size Cap (SEEPIENT_MAX_BODY_BYTES)", () => {
    it("returns 413 PAYLOAD_TOO_LARGE when request body exceeds SEEPIENT_MAX_BODY_BYTES", async () => {
      process.env.SEEPIENT_MAX_BODY_BYTES = "50";

      const sessionManager = new ServerSessionManager({ backend: new MemoryPersistenceBackend() });
      const ctx: RestHandlerContext = {
        sessionManager,
        generateText: vi.fn(),
        listModels: vi.fn().mockResolvedValue([]),
        listSkills: vi.fn().mockReturnValue([]),
        version: "0.7.0",
        startTime: Date.now(),
      };

      const handler = createRestHandler(ctx);
      const largeBody = JSON.stringify({ message: "a".repeat(100) });
      const req = createMockReq(
        "POST",
        "/v1/chat",
        {
          "content-type": "application/json",
          authorization: `Bearer ${key1}`,
        },
        [Buffer.from(largeBody)],
      );
      const res = createMockRes();

      await new Promise<void>((resolve) => {
        res.on("finish", resolve);
        handler(req, res);
      });

      expect(res.statusCode).toBe(413);
      const parsed = JSON.parse(res.body);
      expect(parsed.error?.code).toBe("PAYLOAD_TOO_LARGE");
    });

    it("allows request body when SEEPIENT_MAX_BODY_BYTES=0 (disabled)", async () => {
      process.env.SEEPIENT_MAX_BODY_BYTES = "0";

      const sessionManager = new ServerSessionManager({ backend: new MemoryPersistenceBackend() });
      const ctx: RestHandlerContext = {
        sessionManager,
        generateText: vi.fn().mockResolvedValue({ text: "ok", toolCalls: [] }),
        listModels: vi.fn().mockResolvedValue([]),
        listSkills: vi.fn().mockReturnValue([]),
        version: "0.7.0",
        startTime: Date.now(),
      };

      const handler = createRestHandler(ctx);
      const body = JSON.stringify({ message: "a".repeat(200) });
      const req = createMockReq(
        "POST",
        "/v1/chat",
        {
          "content-type": "application/json",
          authorization: `Bearer ${key1}`,
        },
        [Buffer.from(body)],
      );
      const res = createMockRes();

      await new Promise<void>((resolve) => {
        res.on("finish", resolve);
        handler(req, res);
      });

      expect(res.statusCode).toBe(200);
    });
  });

  describe("2. REST Per-Key Rate Limiting (SEEPIENT_RATE_LIMIT_RPM)", () => {
    it("enforces per-key rate limit, exempts /v1/health, and isolates keys", async () => {
      process.env.SEEPIENT_RATE_LIMIT_RPM = "3";

      const sessionManager = new ServerSessionManager({ backend: new MemoryPersistenceBackend() });
      const ctx: RestHandlerContext = {
        sessionManager,
        generateText: vi.fn().mockResolvedValue({ text: "ok", toolCalls: [] }),
        listModels: vi.fn().mockResolvedValue([]),
        listSkills: vi.fn().mockReturnValue([]),
        version: "0.7.0",
        startTime: Date.now(),
      };

      const handler = createRestHandler(ctx);

      // Key 1: Send 3 requests (within limit of 3)
      for (let i = 0; i < 3; i++) {
        const req = createMockReq("GET", "/v1/sessions", { authorization: `Bearer ${key1}` });
        const res = createMockRes();
        await new Promise<void>((r) => {
          res.on("finish", r);
          handler(req, res);
        });
        expect(res.statusCode).toBe(200);
      }

      // Key 1: 4th request to /v1/sessions exceeds limit -> 429 RATE_LIMITED
      const reqExceeded = createMockReq("GET", "/v1/sessions", { authorization: `Bearer ${key1}` });
      const resExceeded = createMockRes();
      await new Promise<void>((r) => {
        resExceeded.on("finish", r);
        handler(reqExceeded, resExceeded);
      });
      expect(resExceeded.statusCode).toBe(429);
      expect(JSON.parse(resExceeded.body).error?.code).toBe("RATE_LIMITED");

      // Key 1: /v1/health is EXEMPT even when rate limited
      const reqHealth = createMockReq("GET", "/v1/health", { authorization: `Bearer ${key1}` });
      const resHealth = createMockRes();
      await new Promise<void>((r) => {
        resHealth.on("finish", r);
        handler(reqHealth, resHealth);
      });
      expect(resHealth.statusCode).toBe(200);

      // Key 2: Per-key isolation — key 2 has fresh quota
      const reqKey2 = createMockReq("GET", "/v1/sessions", { authorization: `Bearer ${key2}` });
      const resKey2 = createMockRes();
      await new Promise<void>((r) => {
        resKey2.on("finish", r);
        handler(reqKey2, resKey2);
      });
      expect(resKey2.statusCode).toBe(200);
    });
  });

  describe("3. WebSocket Frame Cap (maxPayload: 1 << 20)", () => {
    it("configures maxPayload option to 1 MiB on WebSocketServer", async () => {
      const server = http.createServer();
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      const port = (server.address() as AddressInfo).port;

      const wsServer = await setupWebSocket(server, {
        sessionManager: new ServerSessionManager({ backend: new MemoryPersistenceBackend() }),
        streamText: vi.fn(),
        listModels: vi.fn().mockReturnValue({}),
        listSkills: vi.fn().mockReturnValue([]),
      });

      expect(wsServer).not.toBeNull();
      expect((wsServer as any).options.maxPayload).toBe(1 << 20);

      closeWebSocket();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it("closes real WebSocket connection with code 1009 when client sends frame > 1 MiB", async () => {
      const tempKeyPath = path.join(
        os.tmpdir(),
        `seepient-test-ws-limit-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
      );
      process.env.SEEPIENT_API_KEYS_FILE = tempKeyPath;
      const apiKey = generateApiKey(["agent:run"], { filePath: tempKeyPath });

      const server = http.createServer();
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      const port = (server.address() as AddressInfo).port;

      await setupWebSocket(server, {
        sessionManager: new ServerSessionManager({ backend: new MemoryPersistenceBackend() }),
        streamText: vi.fn(),
        listModels: vi.fn().mockReturnValue({}),
        listSkills: vi.fn().mockReturnValue([]),
      });

      const client = new WsClient(`ws://127.0.0.1:${port}/ws`, {
        headers: {
          authorization: `Bearer ${apiKey.rawKey}`,
        },
      });

      await new Promise<void>((resolve, reject) => {
        client.on("open", () => resolve());
        client.on("error", reject);
      });

      // Avoid unhandled error if client emits error on protocol close
      client.on("error", () => {});

      const closePromise = new Promise<{ code: number; reason: string }>((resolve) => {
        client.on("close", (code: number, reason: Buffer) => {
          resolve({ code, reason: reason.toString() });
        });
      });

      // Send payload exceeding 1 MiB (1 << 20 = 1048576)
      const oversizedPayload = Buffer.alloc((1 << 20) + 1024, "x");
      client.send(oversizedPayload);

      const closeEvent = await closePromise;
      expect(closeEvent.code).toBe(1009);

      closeWebSocket();
      await new Promise<void>((resolve) => server.close(() => resolve()));

      try {
        fs.unlinkSync(tempKeyPath);
      } catch {}
    });
  });
});
