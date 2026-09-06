/**
 * Transport polish (021-4 W160/W161).
 *
 * W160 — every REST body read goes through the shared capped reader:
 *        oversized settings and gateway bodies answer 413, not 500.
 * W161 — server.rateLimitRpm is re-read per consume, so a settings PATCH
 *        takes effect without a restart.
 */

import { describe, it, expect } from "vitest";
import { createRestHandler, type RestHandlerContext } from "../rest.js";
import { RateLimiter } from "../rate-limit.js";
import { parseBody } from "../body.js";
import { SettingsManager } from "../../../domain/settings/settings-manager.js";
import { ServerSessionManager } from "../session-store.js";
import { MemoryPersistenceBackend } from "../../../domain/sessions/session-store.js";
import { generateApiKey } from "../../auth/auth.js";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function mockReq(method: string, path: string, headers: Record<string, string> = {}, body?: string): http.IncomingMessage {
  return {
    method,
    url: path,
    headers,
    on: (event: string, cb: (chunk?: Buffer) => void) => {
      if (event === "data" && body) cb(Buffer.from(body));
      if (event === "end") cb();
    },
  } as unknown as http.IncomingMessage;
}

function mockRes() {
  const state = { body: "", statusCode: undefined as number | undefined };
  const res = {
    writeHead(code: number) { state.statusCode = code; return res; },
    setHeader() {},
    end(chunk?: string) { if (chunk) state.body += chunk; },
    on(_e: string, cb: () => void) { cb(); return res; },
    get statusCode() { return state.statusCode; },
    get body() { return state.body; },
  } as unknown as http.ServerResponse & { body: string; statusCode?: number };
  return res;
}

function makeCtx(overrides: Partial<RestHandlerContext> = {}): RestHandlerContext {
  return {
    version: "test",
    startTime: Date.now(),
    sessionManager: new ServerSessionManager({ backend: new MemoryPersistenceBackend() }),
    generateText: async () => {
      throw new Error("unused");
    },
    listModels: () => ({}),
    listSkills: () => [],
    ...overrides,
  };
}

describe("W160 — unified body caps answer 413", () => {
  const tempFiles: string[] = [];

  function adminKey(): string {
    const p = path.join(os.tmpdir(), `seepient-caps-keys-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    tempFiles.push(p);
    process.env.SEEPIENT_API_KEYS_FILE = p;
    return generateApiKey(["admin"], { filePath: p }).rawKey!;
  }

  it("an oversized settings PATCH body gets a 413 envelope", async () => {
    const rawKey = adminKey();
    const settingsManager = new SettingsManager({ config: {} });
    const handler = createRestHandler(makeCtx({ settingsHandlerContext: { settingsManager, getOtherClients: () => [] } }));

    const bigBody = JSON.stringify({ general: { defaultModel: "x".repeat(11 * 1024 * 1024) } });
    const res = mockRes();
    await handler(
      mockReq("PATCH", "/v1/settings", {
        "content-type": "application/json",
        authorization: `Bearer ${rawKey}`,
      }, bigBody),
      res as unknown as http.ServerResponse,
    );

    expect(res.statusCode).toBe(413);
    expect(res.body).toContain("PAYLOAD_TOO_LARGE");
  });

  it("an oversized gateway body gets a 413 envelope", async () => {
    const rawKey = adminKey();
    let gatewaySawRequest = false;
    const handler = createRestHandler(makeCtx({
      gatewayHandler: async (req) => {
        // Mirror the real handler: read the body through the shared reader
        await parseBody(req);
        gatewaySawRequest = true;
      },
    }));

    const res = mockRes();
    await handler(
      mockReq("POST", "/v1/gateway/targets", {
        "content-type": "application/json",
        authorization: `Bearer ${rawKey}`,
      }, JSON.stringify({ blob: "y".repeat(11 * 1024 * 1024) })),
      res as unknown as http.ServerResponse,
    );

    // The body must be rejected before the gateway handler ever sees it
    expect(gatewaySawRequest).toBe(false);
    expect(res.statusCode).toBe(413);
    expect(res.body).toContain("PAYLOAD_TOO_LARGE");
  });
});

describe("W161 — rateLimitRpm re-read per consume", () => {
  const savedRpmEnv = process.env.SEEPIENT_RATE_LIMIT_RPM;

  it("a RateLimiter with a live provider picks up the new rpm immediately", () => {
    delete process.env.SEEPIENT_RATE_LIMIT_RPM;
    let rpm: number | undefined = 300;
    const limiter = new RateLimiter(300, () => rpm);

    expect(limiter.getRpm()).toBe(300);
    rpm = 1; // PATCH server.rateLimitRpm=1
    expect(limiter.getRpm()).toBe(1);

    expect(limiter.consume("key-a")).toBe(true);  // first token ok
    expect(limiter.consume("key-a")).toBe(false); // now limited by rpm=1

    rpm = 0; // disabled
    expect(limiter.consume("key-a")).toBe(true);

    if (savedRpmEnv !== undefined) process.env.SEEPIENT_RATE_LIMIT_RPM = savedRpmEnv;
  });

  it("the env override still wins over the provider", () => {
    const original = process.env.SEEPIENT_RATE_LIMIT_RPM;
    try {
      process.env.SEEPIENT_RATE_LIMIT_RPM = "42";
      let rpm: number | undefined = 300;
      const limiter = new RateLimiter(300, () => rpm);
      expect(limiter.getRpm()).toBe(42);
    } finally {
      if (original !== undefined) process.env.SEEPIENT_RATE_LIMIT_RPM = original;
      else delete process.env.SEEPIENT_RATE_LIMIT_RPM;
    }
  });
});
