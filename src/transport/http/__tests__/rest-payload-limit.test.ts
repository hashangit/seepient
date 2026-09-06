import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import http from "node:http";
import net from "node:net";
import { createRestHandler, type RestHandlerContext } from "../rest.js";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { ServerSessionManager } from "../session-store.js";
import { MemoryPersistenceBackend } from "../../../domain/sessions/session-store.js";
import { generateApiKey } from "../../auth/auth.js";

describe("W015: 413 Deliverability over real sockets", () => {
  let server: http.Server;
  let serverPort: number;
  let tempKeyPath: string;
  let key1: string;
  let originalMaxBodyBytes: string | undefined;
  let originalKeysFile: string | undefined;

  beforeEach(async () => {
    originalMaxBodyBytes = process.env.SEEPIENT_MAX_BODY_BYTES;
    originalKeysFile = process.env.SEEPIENT_API_KEYS_FILE;
    process.env.SEEPIENT_MAX_BODY_BYTES = "100"; // 100 bytes limit

    tempKeyPath = path.join(
      os.tmpdir(),
      `seepient-limits-keys-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
    );
    process.env.SEEPIENT_API_KEYS_FILE = tempKeyPath;
    const k1 = generateApiKey(["agent:run"], { filePath: tempKeyPath });
    key1 = k1.rawKey;

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
    server = http.createServer(handler);

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as net.AddressInfo;
        serverPort = addr.port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    if (originalMaxBodyBytes !== undefined) {
      process.env.SEEPIENT_MAX_BODY_BYTES = originalMaxBodyBytes;
    } else {
      delete process.env.SEEPIENT_MAX_BODY_BYTES;
    }
    if (originalKeysFile !== undefined) {
      process.env.SEEPIENT_API_KEYS_FILE = originalKeysFile;
    } else {
      delete process.env.SEEPIENT_API_KEYS_FILE;
    }
    try {
      if (fs.existsSync(tempKeyPath)) fs.unlinkSync(tempKeyPath);
    } catch {
      // ignore
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("delivers 413 JSON envelope on Content-Length precheck before reading", async () => {
    const largePayload = JSON.stringify({ message: "x".repeat(500) });

    const response = await new Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: serverPort,
          path: "/v1/chat",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(largePayload),
            Authorization: `Bearer ${key1}`,
          },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            resolve({
              statusCode: res.statusCode ?? 0,
              headers: res.headers,
              body: data,
            });
          });
        },
      );

      req.on("error", reject);
      req.write(largePayload);
      req.end();
    });

    expect(response.statusCode).toBe(413);
    expect(response.headers["connection"]).toBe("close");
    const parsed = JSON.parse(response.body);
    expect(parsed.error?.code).toBe("PAYLOAD_TOO_LARGE");
    expect(parsed.error?.message).toMatch(/exceeded maximum limit of 100 bytes/i);
  });

  it("delivers 413 JSON envelope on chunked transfer overflow without ECONNRESET", async () => {
    // Send in chunks without Content-Length header
    const response = await new Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: serverPort,
          path: "/v1/chat",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Transfer-Encoding": "chunked",
            Authorization: `Bearer ${key1}`,
          },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            resolve({
              statusCode: res.statusCode ?? 0,
              headers: res.headers,
              body: data,
            });
          });
        },
      );

      req.on("error", (err) => {
        // If ECONNRESET happens, the test will fail here
        reject(err);
      });

      // Write chunks exceeding 100 bytes
      req.write(Buffer.from('{"message": "'));
      req.write(Buffer.alloc(80, "a"));
      req.write(Buffer.alloc(80, "b"));
      req.write(Buffer.from('"}'));
      req.end();
    });

    expect(response.statusCode).toBe(413);
    expect(response.headers["connection"]).toBe("close");
    const parsed = JSON.parse(response.body);
    expect(parsed.error?.code).toBe("PAYLOAD_TOO_LARGE");
    expect(parsed.error?.message).toMatch(/exceeded maximum limit of 100 bytes/i);
  });
});
