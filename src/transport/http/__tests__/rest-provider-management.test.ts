import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { createRestHandler } from "../rest.js";
import { generateApiKey } from "../../auth/auth.js";
import { ProviderConfigStore } from "../../../domain/providers/config-store/provider-config-store.js";
import { MemoryCredentialStore } from "../../../domain/providers/credentials/memory-credential-store.js";
import { ProviderRuntime } from "../../../domain/providers/provider-runtime.js";
import { AggregateInferenceAdapter } from "../../../capabilities/inference/aggregate-adapter.js";
import { EventEmitter } from "events";

function createMockReqRes(method: string, url: string, headers: Record<string, string> = {}, body?: string) {
  const req = new EventEmitter() as any;
  req.method = method;
  req.url = url;
  req.headers = headers;

  const res = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: "",
    setHeader(k: string, v: string) {
      this.headers[k.toLowerCase()] = v;
    },
    writeHead(code: number, headers?: Record<string, string>) {
      this.statusCode = code;
      if (headers) {
        for (const [k, v] of Object.entries(headers)) {
          this.headers[k.toLowerCase()] = v;
        }
      }
    },
    end(data?: string) {
      if (data) this.body += data;
      this.emit("finish");
    },
  } as any;
  Object.setPrototypeOf(res, EventEmitter.prototype);

  setTimeout(() => {
    if (body) {
      req.emit("data", Buffer.from(body));
    }
    req.emit("end");
  }, 5);

  return { req, res };
}

import * as os from "os";
import * as fs from "fs";
import * as path from "path";

describe("REST Provider Management v2 API (QS-P6.3 & QS-P6.4)", () => {
  const tempKeyPath = path.join(
    os.tmpdir(),
    `seepient-test-keys-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
  process.env.SEEPIENT_API_KEYS_FILE = tempKeyPath;

  const readKey = generateApiKey(["provider:read"], { label: "reader", filePath: tempKeyPath });
  const adminKey = generateApiKey(["provider:admin"], { label: "admin", filePath: tempKeyPath });

  const configStore = new ProviderConfigStore(":memory:");
  const credStore = new MemoryCredentialStore();
  const runtime = new ProviderRuntime({
    configStore,
    credentialStore: credStore,
    adapter: new AggregateInferenceAdapter({}),
  });

  beforeAll(async () => {
    await configStore.updateOverlay(
      {
        modelAssignments: {
          text: {
            standard: { providerAccount: "openai", model: "gpt-4o" },
          },
        },
      },
      0,
    );
  });

  afterAll(() => {
    delete process.env.SEEPIENT_API_KEYS_FILE;
    if (fs.existsSync(tempKeyPath)) {
      try { fs.unlinkSync(tempKeyPath); } catch {}
    }
  });

  const dummyCtx: any = {
    version: "0.2.2",
    startTime: Date.now(),
    listModels: () => [],
    listSkills: () => [],
    generateText: vi.fn(),
    sessionManager: { getSession: vi.fn() },
    providerRuntime: runtime,
  };

  const handler = createRestHandler(dummyCtx);

  it("GET /v1/provider-runtime returns revision and sources with provider:read scope", async () => {
    const { req, res } = createMockReqRes("GET", "/v1/provider-runtime", {
      authorization: `Bearer ${readKey.rawKey}`,
    });

    await new Promise<void>((resolve) => {
      res.on("finish", () => resolve());
      handler(req, res);
    });

    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.revision).toBeDefined();
  });

  it("GET /v1/models/assignments returns effective assignments", async () => {
    const { req, res } = createMockReqRes("GET", "/v1/models/assignments", {
      authorization: `Bearer ${readKey.rawKey}`,
    });

    await new Promise<void>((resolve) => {
      res.on("finish", () => resolve());
      handler(req, res);
    });

    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.text).toBeDefined();
  });

  it("PUT /v1/models/assignments/text/standard enforces If-Match header", async () => {
    // Missing If-Match -> 428 Precondition Required
    const { req: req1, res: res1 } = createMockReqRes(
      "PUT",
      "/v1/models/assignments/text/standard",
      {
        authorization: `Bearer ${adminKey.rawKey}`,
      },
      JSON.stringify({ providerAccount: "openai", model: "gpt-4o" }),
    );

    await new Promise<void>((resolve) => {
      res1.on("finish", () => resolve());
      handler(req1, res1);
    });

    expect(res1.statusCode).toBe(428);

    // Stale If-Match -> 409 Conflict
    const { req: req2, res: res2 } = createMockReqRes(
      "PUT",
      "/v1/models/assignments/text/standard",
      {
        authorization: `Bearer ${adminKey.rawKey}`,
        "if-match": "9999",
      },
      JSON.stringify({ providerAccount: "openai", model: "gpt-4o" }),
    );

    await new Promise<void>((resolve) => {
      res2.on("finish", () => resolve());
      handler(req2, res2);
    });

    expect(res2.statusCode).toBe(409);
  });

  it("rejects mutations when API key lacks provider:admin scope", async () => {
    const { req, res } = createMockReqRes(
      "PUT",
      "/v1/models/assignments/text/standard",
      {
        authorization: `Bearer ${readKey.rawKey}`,
        "if-match": "0",
      },
      JSON.stringify({ providerAccount: "openai", model: "gpt-4o" }),
    );

    await new Promise<void>((resolve) => {
      res.on("finish", () => resolve());
      handler(req, res);
    });

    expect(res.statusCode).toBe(403);
  });
});
