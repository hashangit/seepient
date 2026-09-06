import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRestHandler, type RestHandlerContext } from "../http/rest.js";
import { ServerSessionManager } from "../http/session-store.js";
import { MemoryPersistenceBackend } from "../../domain/sessions/session-store.js";
import { generateApiKey } from "../auth/auth.js";
import { EventEmitter } from "events";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { logTransportEvent, type LogLine } from "../logging.js";

function createMockReq(
  method: string,
  url: string,
  headers: Record<string, string> = {},
  body = "",
) {
  const req = new EventEmitter() as any;
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.socket = { remoteAddress: "127.0.0.1" };

  setTimeout(() => {
    if (body) req.emit("data", Buffer.from(body));
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

describe("Structured Logging & Error Sanitization (Spec 021-2 / T019, T023, QS-7)", () => {
  let stdoutChunks: string[] = [];
  let originalWrite: typeof process.stdout.write;
  let tempKeyPath: string;
  let originalKeysFile: string | undefined;
  let apiKey: string;

  beforeEach(() => {
    stdoutChunks = [];
    originalWrite = process.stdout.write;
    process.stdout.write = vi.fn((chunk: string | Uint8Array) => {
      stdoutChunks.push(chunk.toString());
      return true;
    }) as any;

    originalKeysFile = process.env.SEEPIENT_API_KEYS_FILE;
    tempKeyPath = path.join(
      os.tmpdir(),
      `seepient-log-keys-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
    );
    process.env.SEEPIENT_API_KEYS_FILE = tempKeyPath;
    const k = generateApiKey(["agent:run", "admin"], { filePath: tempKeyPath });
    apiKey = k.rawKey;
  });

  afterEach(() => {
    process.stdout.write = originalWrite;
    if (originalKeysFile !== undefined) process.env.SEEPIENT_API_KEYS_FILE = originalKeysFile;
    else delete process.env.SEEPIENT_API_KEYS_FILE;

    try {
      if (fs.existsSync(tempKeyPath)) fs.unlinkSync(tempKeyPath);
    } catch {
      // ignore
    }
  });

  it("emits structured JSON-line log for http_request with requestId and no raw API key", async () => {
    const sessionManager = new ServerSessionManager({ backend: new MemoryPersistenceBackend() });
    const ctx: RestHandlerContext = {
      sessionManager,
      generateText: vi.fn().mockResolvedValue({ text: "hello", toolCalls: [] }),
      listModels: vi.fn().mockResolvedValue([]),
      listSkills: vi.fn().mockReturnValue([]),
      version: "0.7.0",
      startTime: Date.now(),
    };

    const handler = createRestHandler(ctx);
    const rawSecretKey = "sk_live_very_secret_key_123456789abcdef";
    const req = createMockReq("GET", "/v1/health", { authorization: `Bearer ${rawSecretKey}` });
    const res = createMockRes();

    await new Promise<void>((resolve) => {
      res.on("finish", resolve);
      handler(req, res);
    });

    expect(res.statusCode).toBe(200);

    // Find the http_request log line
    const logLines = stdoutChunks
      .join("")
      .split("\n")
      .filter((line) => line.trim().startsWith("{") && line.trim().endsWith("}"))
      .map((line) => JSON.parse(line) as LogLine);

    const httpLog = logLines.find((l) => l.event === "http_request");
    expect(httpLog).toBeDefined();
    expect(httpLog!.requestId).toMatch(/^[0-9a-f-]{36}$/); // Valid UUID
    expect(httpLog!.method).toBe("GET");
    expect(httpLog!.path).toBe("/v1/health");
    expect(httpLog!.status).toBe(200);
    expect(typeof httpLog!.durationMs).toBe("number");

    // Must never leak the full raw API key
    const allStdout = stdoutChunks.join("");
    expect(allStdout).not.toContain(rawSecretKey);

    // If apiKeyHashPrefix is present, must be at most 8 chars
    if (httpLog!.apiKeyHashPrefix) {
      expect(httpLog!.apiKeyHashPrefix.length).toBeLessThanOrEqual(8);
    }
  });

  it("sanitizes 500 error responses: generic body to client, details in internal log", async () => {
    const sessionManager = new ServerSessionManager({ backend: new MemoryPersistenceBackend() });
    const secretErrorMessage = "DATABASE_PASSWORD_LEAK: postgres://user:secret@db/prod";

    const ctx: RestHandlerContext = {
      sessionManager,
      generateText: vi.fn().mockRejectedValue(new Error(secretErrorMessage)),
      listModels: vi.fn().mockResolvedValue([]),
      listSkills: vi.fn().mockReturnValue([]),
      version: "0.7.0",
      startTime: Date.now(),
    };

    const handler = createRestHandler(ctx);
    const body = JSON.stringify({ message: "trigger 500" });
    const req = createMockReq(
      "POST",
      "/v1/chat",
      {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body,
    );
    const res = createMockRes();

    await new Promise<void>((resolve) => {
      res.on("finish", resolve);
      handler(req, res);
    });

    expect(res.statusCode).toBe(500);

    // Client response MUST NOT contain the secret error message
    expect(res.body).not.toContain(secretErrorMessage);
    const parsed = JSON.parse(res.body);
    expect(parsed.error?.message).toBe("Internal server error during generation");

    // Internal log MUST contain the error details
    const logLines = stdoutChunks
      .join("")
      .split("\n")
      .filter((line) => line.trim().startsWith("{") && line.trim().endsWith("}"))
      .map((line) => JSON.parse(line) as LogLine);

    const errorLog = logLines.find((l) => l.level === "error");
    expect(errorLog).toBeDefined();
    expect(errorLog!.error).toContain(secretErrorMessage);
  });
});
