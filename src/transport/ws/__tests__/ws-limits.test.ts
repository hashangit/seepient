/**
 * WS rate limiting & connection caps (021-4 W146).
 *
 * WS messages must consume from the same per-key limiter REST uses, a valid
 * key must not be able to open unlimited connections, and non-`/ws` upgrade
 * requests must be answered (404) and destroyed instead of left dangling.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
// @ts-expect-error — ws is an optional peer dependency without bundled types
import { WebSocket as WsClient } from "ws";
import { handleConnection } from "../ws-handlers.js";
import { setupWebSocket } from "../websocket.js";
import { createConnectionRegistry } from "../connection-registry.js";
import { ServerSessionManager } from "../../http/session-store.js";
import { MemoryPersistenceBackend } from "../../../domain/sessions/session-store.js";
import { generateApiKey } from "../../auth/auth.js";
import type { WebSocket, WebSocketHandlerContext } from "../ws-types.js";

function makeCtx(overrides: Partial<WebSocketHandlerContext> = {}): WebSocketHandlerContext {
  return {
    registry: createConnectionRegistry(),
    sessionManager: new ServerSessionManager({ backend: new MemoryPersistenceBackend() }),
    streamText: vi.fn(),
    listModels: () => ({}),
    listSkills: () => [],
    ...overrides,
  };
}

function makeMockWs() {
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

describe("W146 — WS message rate limiting (dispatcher-level)", () => {
  const tempFiles: string[] = [];

  afterEach(() => {
    for (const f of tempFiles.splice(0)) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  function makeKeysFile(): string {
    const p = path.join(os.tmpdir(), `seepient-ws-limit-keys-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    tempFiles.push(p);
    process.env.SEEPIENT_API_KEYS_FILE = p;
    return generateApiKey(["agent:run"], { filePath: p }).rawKey!;
  }

  it("a rejected message gets a RATE_LIMITED error frame and is not dispatched", async () => {
    const rawKey = makeKeysFile();
    const ctx = makeCtx({
      rateLimiter: { consume: () => false, getRetryAfterSeconds: () => 3 },
    });
    const { ws, sent, handlers } = makeMockWs();
    const req = { headers: { authorization: `Bearer ${rawKey}` } } as any;

    handleConnection(ws, req, ctx);
    const onMessage = handlers.get("message")!;
    expect(onMessage).toBeDefined();

    onMessage(Buffer.from(JSON.stringify({ type: "chat", id: "m1", message: "flood" })));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(ctx.streamText).not.toHaveBeenCalled();
    const err = sent.find((f) => f.type === "error");
    expect(err).toBeDefined();
    expect(err.code).toBe("RATE_LIMITED");
    expect(err.retryable).toBe(true);
  });

  it("messages pass when the limiter allows them", async () => {
    const rawKey = makeKeysFile();
    const ctx = makeCtx({
      rateLimiter: { consume: () => true, getRetryAfterSeconds: () => 0 },
    });
    ctx.streamText = vi.fn((opts: any) => {
      opts.onDone({
        text: "ok",
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0 },
        finishReason: "stop",
      });
    });
    const { ws, sent, handlers } = makeMockWs();
    const req = { headers: { authorization: `Bearer ${rawKey}` } } as any;

    handleConnection(ws, req, ctx);
    handlers.get("message")!(Buffer.from(JSON.stringify({ type: "chat", id: "m1", message: "hi" })));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(ctx.streamText).toHaveBeenCalledTimes(1);
    expect(sent.find((f) => f.type === "error")).toBeUndefined();
  });
});

describe("W146 — WS connection cap and upgrade hygiene", () => {
  const tempFiles: string[] = [];
  const servers: http.Server[] = [];
  const clients: WsClient[] = [];

  afterEach(async () => {
    for (const c of clients.splice(0)) {
      c.terminate();
    }
    for (const s of servers.splice(0)) {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
    for (const f of tempFiles.splice(0)) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  function makeKeysFile(): string {
    const p = path.join(os.tmpdir(), `seepient-ws-limits-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    tempFiles.push(p);
    process.env.SEEPIENT_API_KEYS_FILE = p;
    return generateApiKey(["agent:run"], { filePath: p }).rawKey!;
  }

  /** Raw HTTP upgrade request; resolves with the HTTP status the server answers. */
  function rawUpgrade(port: number, rawKey: string, reqPath: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: "127.0.0.1",
        port,
        path: reqPath,
        headers: {
          connection: "Upgrade",
          upgrade: "websocket",
          authorization: `Bearer ${rawKey}`,
        },
      });
      req.on("response", (res) => {
        resolve(res.statusCode!);
        res.resume();
      });
      req.on("upgrade", (_res, socket) => {
        socket.destroy();
        reject(new Error("upgrade should not succeed"));
      });
      req.on("error", reject);
      req.end();
    });
  }

  it("404s and destroys non-/ws upgrade requests", async () => {
    const rawKey = makeKeysFile();
    const server = http.createServer();
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as { port: number }).port;
    await setupWebSocket(server, makeCtx());

    const status = await rawUpgrade(port, rawKey, "/not-ws");
    expect(status).toBe(404);
  });

  it("enforces the per-key connection cap", async () => {
    const rawKey = makeKeysFile();
    process.env.SEEPIENT_WS_MAX_CONNECTIONS_PER_KEY = "1";

    try {
      const server = http.createServer();
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      const port = (server.address() as { port: number }).port;
      await setupWebSocket(server, makeCtx());

      // First connection for the key succeeds
      const first = new WsClient(`ws://127.0.0.1:${port}/ws`, {
        headers: { authorization: `Bearer ${rawKey}` },
      });
      clients.push(first);
      await new Promise<void>((resolve, reject) => {
        first.on("open", () => resolve());
        first.on("error", reject);
      });

      // Second connection for the same key is refused with 429
      const status = await rawUpgrade(port, rawKey, "/ws");
      expect(status).toBe(429);

      // A different path never reaches the cap check — sanity for the 404 path
      first.close();
    } finally {
      delete process.env.SEEPIENT_WS_MAX_CONNECTIONS_PER_KEY;
    }
  });
});
