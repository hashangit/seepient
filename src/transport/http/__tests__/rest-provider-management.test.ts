import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { createRestHandler } from "../rest.js";
import { generateApiKey } from "../../auth/auth.js";
import { ProviderConfigStore } from "../../../domain/providers/config-store/provider-config-store.js";
import { MemoryCredentialStore } from "../../../domain/providers/credentials/memory-credential-store.js";
import { ProviderRuntime } from "../../../domain/providers/provider-runtime.js";
import { AggregateInferenceAdapter } from "../../../capabilities/inference/aggregate-adapter.js";
import { EventEmitter } from "events";

import { Readable } from "stream";

function createMockReqRes(method: string, url: string, headers: Record<string, string> = {}, body?: string) {
  const req = Readable.from(body ? [Buffer.from(body)] : []) as any;
  req.method = method;
  req.url = url;
  req.headers = headers;

  const res = new EventEmitter() as any;
  res.statusCode = 200;
  res.headers = {};
  res.body = "";
  res.setHeader = function(k: string, v: string) {
    this.headers[k.toLowerCase()] = v;
  };
  res.writeHead = function(code: number, headers?: Record<string, string>) {
    this.statusCode = code;
    if (headers) {
      for (const [k, v] of Object.entries(headers)) {
        this.headers[k.toLowerCase()] = v;
      }
    }
  };
  res.end = function(data?: string) {
    if (data) this.body += data;
    this.emit("finish");
  };

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

  it("GET /v1/catalog includes reachableVia per model (FR-036 / T053)", async () => {
    // Configure an account
    await credStore.put("openai", { kind: "api_key", keyValue: "sk-test-12345678901234567890" });
    const ov = await configStore.getOverlay();
    await configStore.updateOverlay(
      {
        providers: {
          openai: {
            adapter: "pi-ai",
            upstreamProvider: "openai",
            credential: { kind: "seepient", id: "openai" },
          },
        },
      },
      ov.revision,
    );

    const { req, res } = createMockReqRes("GET", "/v1/catalog", {
      authorization: `Bearer ${readKey.rawKey}`,
    });

    await new Promise<void>((resolve) => {
      res.on("finish", () => resolve());
      handler(req, res);
    });

    expect(res.statusCode).toBe(200);
    const catalog = JSON.parse(res.body);
    expect(Array.isArray(catalog)).toBe(true);
    expect(catalog.length).toBeGreaterThan(0);
    expect(catalog[0]).toHaveProperty("reachableVia");
    const openaiModel = catalog.find((m: any) => m.upstreamProvider === "openai");
    if (openaiModel) {
      expect(openaiModel.reachableVia).toContain("openai");
    }
  });

  it("POST /v1/providers/:id/oauth/start requires provider:admin scope (T054)", async () => {
    const { req, res } = createMockReqRes("POST", "/v1/providers/anthropic/oauth/start", {
      authorization: `Bearer ${readKey.rawKey}`,
    });

    await new Promise<void>((resolve) => {
      res.on("finish", () => resolve());
      handler(req, res);
    });

    expect(res.statusCode).toBe(403);
  });

  it("POST /v1/providers/:id/oauth/complete validates attemptId (T054)", async () => {
    const { req, res } = createMockReqRes(
      "POST",
      "/v1/providers/anthropic/oauth/complete",
      { authorization: `Bearer ${adminKey.rawKey}` },
      JSON.stringify({ attemptId: "non-existent-attempt" }),
    );

    await new Promise<void>((resolve) => {
      res.on("finish", () => resolve());
      handler(req, res);
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("OAUTH_ATTEMPT_NOT_FOUND");
  });

  it("POST /v1/providers/:id/oauth/start and complete full relay lifecycle (FR-037 / T054)", async () => {
    // Mock getOAuthFlow
    const oauthService = await import("../../../domain/providers/oauth-service.js");
    const mockFlow = {
      login: vi.fn(async (interaction: any) => {
        expect(interaction.signal).toBeDefined();
        setTimeout(() => {
          interaction.notify({
            type: "device_code",
            userCode: "TEST-CODE-1234",
            verificationUri: "https://anthropic.com/device",
            expiresInSeconds: 300,
          });
        }, 10);
        return {
          type: "oauth",
          access: "relayed-access-token",
          refresh: "relayed-refresh-token",
          expires: Date.now() + 3600_000,
        };
      }),
    };
    vi.spyOn(oauthService, "getOAuthFlow").mockResolvedValue(mockFlow as any);

    // 1. Start relay
    const startReq = createMockReqRes("POST", "/v1/providers/anthropic/oauth/start", {
      authorization: `Bearer ${adminKey.rawKey}`,
    });
    await new Promise<void>((resolve) => {
      startReq.res.on("finish", () => resolve());
      handler(startReq.req, startReq.res);
    });

    expect(startReq.res.statusCode).toBe(200);
    const startBody = JSON.parse(startReq.res.body);
    expect(startBody.attemptId).toBeDefined();
    expect(startBody.userCode).toBe("TEST-CODE-1234");
    expect(startBody.verificationUrl).toBe("https://anthropic.com/device");

    // 2. Complete mismatch provider check
    const mismatchReq = createMockReqRes(
      "POST",
      "/v1/providers/openai/oauth/complete",
      { authorization: `Bearer ${adminKey.rawKey}` },
      JSON.stringify({ attemptId: startBody.attemptId }),
    );
    await new Promise<void>((resolve) => {
      mismatchReq.res.on("finish", () => resolve());
      handler(mismatchReq.req, mismatchReq.res);
    });
    expect(mismatchReq.res.statusCode).toBe(400);
    const mismatchBody = JSON.parse(mismatchReq.res.body);
    expect(mismatchBody.error.code).toBe("OAUTH_PROVIDER_MISMATCH");

    // 3. Complete happy path
    const completeReq = createMockReqRes(
      "POST",
      "/v1/providers/anthropic/oauth/complete",
      { authorization: `Bearer ${adminKey.rawKey}` },
      JSON.stringify({ attemptId: startBody.attemptId }),
    );
    await new Promise<void>((resolve) => {
      completeReq.res.on("finish", () => resolve());
      handler(completeReq.req, completeReq.res);
    });
    expect(completeReq.res.statusCode).toBe(200);

    // Verify stored credential
    const storedCred = await (credStore as any).getRecord("anthropic");
    expect(storedCred).toBeDefined();
    expect((storedCred as any).access).toBe("relayed-access-token");
  });

  it("OAuth complete rollback preserves pre-existing api_key secret on failure (N1)", async () => {
    // 1. Seed pre-existing API key credential
    await credStore.put("openai-preexisting", {
      kind: "api_key",
      keyValue: "sk-original-secret-key-12345",
    }, { source: "disk", description: "Original key" });

    const oauthService = await import("../../../domain/providers/oauth-service.js");
    const mockFlow = {
      login: vi.fn(async (interaction: any) => {
        setTimeout(() => {
          interaction.notify({
            type: "device_code",
            userCode: "TEST-CODE-ROLLBACK",
            verificationUri: "https://openai.com/device",
            expiresInSeconds: 300,
          });
        }, 10);
        // Simulate failure returning invalid credentials
        return { type: "oauth", access: "" };
      }),
    };
    vi.spyOn(oauthService, "getOAuthFlow").mockResolvedValue(mockFlow as any);

    // Start relay for openai-preexisting
    const startReq = createMockReqRes("POST", "/v1/providers/openai-preexisting/oauth/start", {
      authorization: `Bearer ${adminKey.rawKey}`,
    });
    await new Promise<void>((resolve) => {
      startReq.res.on("finish", () => resolve());
      handler(startReq.req, startReq.res);
    });
    const startBody = JSON.parse(startReq.res.body);

    // Complete fails due to invalid tokens
    const completeReq = createMockReqRes(
      "POST",
      "/v1/providers/openai-preexisting/oauth/complete",
      { authorization: `Bearer ${adminKey.rawKey}` },
      JSON.stringify({ attemptId: startBody.attemptId }),
    );
    await new Promise<void>((resolve) => {
      completeReq.res.on("finish", () => resolve());
      handler(completeReq.req, completeReq.res);
    });
    expect(completeReq.res.statusCode).toBe(400);

    // Assert pre-existing credential survived intact with original secret
    const preserved = await (credStore as any).getRecord("openai-preexisting");
    expect(preserved).toBeDefined();
    expect(preserved.kind).toBe("api_key");
    expect(preserved.keyValue).toBe("sk-original-secret-key-12345");
  });

  it("POST /v1/providers/:id/oauth/start fails fast on early login rejection (N6)", async () => {
    const oauthService = await import("../../../domain/providers/oauth-service.js");
    const mockFlow = {
      login: vi.fn(async () => {
        throw new Error("Immediate connection failure");
      }),
    };
    vi.spyOn(oauthService, "getOAuthFlow").mockResolvedValue(mockFlow as any);

    const startReq = createMockReqRes("POST", "/v1/providers/anthropic/oauth/start", {
      authorization: `Bearer ${adminKey.rawKey}`,
    });
    await new Promise<void>((resolve) => {
      startReq.res.on("finish", () => resolve());
      handler(startReq.req, startReq.res);
    });

    expect(startReq.res.statusCode).toBe(400);
    const body = JSON.parse(startReq.res.body);
    expect(body.error.code).toBe("OAUTH_FLOW_ERROR");
    expect(body.error.message).toContain("Immediate connection failure");
  });

  it("handles media.image assignment route with dot notation (R15)", async () => {
    const putReq = createMockReqRes(
      "PUT",
      "/v1/models/assignments/media.image",
      { authorization: `Bearer ${adminKey.rawKey}`, "if-match": "*" },
      JSON.stringify({ providerAccount: "openai", model: "dall-e-3" }),
    );
    await new Promise<void>((resolve) => {
      putReq.res.on("finish", () => resolve());
      handler(putReq.req, putReq.res);
    });
    expect(putReq.res.statusCode).toBe(200);

    const getReq = createMockReqRes(
      "GET",
      "/v1/models/assignments/media.image",
      { authorization: `Bearer ${readKey.rawKey}` },
    );
    await new Promise<void>((resolve) => {
      getReq.res.on("finish", () => resolve());
      handler(getReq.req, getReq.res);
    });
    expect(getReq.res.statusCode).toBe(200);
    const body = JSON.parse(getReq.res.body);
    expect(body.model).toBe("dall-e-3");
  });

  it("PUT /v1/providers/:id routes through controller with sanitization and validation", async () => {
    const putReq = createMockReqRes(
      "PUT",
      "/v1/providers/test-acct",
      { authorization: `Bearer ${adminKey.rawKey}`, "if-match": "*" },
      JSON.stringify({
        upstreamProvider: "openai",
        credential: { kind: "none" },
        baseUrl: "http://127.0.0.1:9090/v1",
        allowPrivate: true,
      }),
    );
    await new Promise<void>((resolve) => {
      putReq.res.on("finish", () => resolve());
      handler(putReq.req, putReq.res);
    });
    expect(putReq.res.statusCode).toBe(200);
    const body = JSON.parse(putReq.res.body);
    expect(body.provider.id).toBe("test-acct");
    expect(body.provider.credential.kind).toBe("none");
  });

  it("GET /v1/providers redacts sensitive query parameters from baseUrl", async () => {
    await configStore.updateOverlay({
      providers: {
        "sensitive-url-acct": {
          adapter: "pi-ai",
          upstreamProvider: "openai",
          baseUrl: "https://proxy.example.com/v1?api_key=supersecret123&token=abc",
          credential: { kind: "none" },
        } as any,
      },
    }, (await configStore.getOverlay()).revision);

    const getReq = createMockReqRes(
      "GET",
      "/v1/providers/sensitive-url-acct",
      { authorization: `Bearer ${readKey.rawKey}` },
    );
    await new Promise<void>((resolve) => {
      getReq.res.on("finish", () => resolve());
      handler(getReq.req, getReq.res);
    });
    expect(getReq.res.statusCode).toBe(200);
    const body = JSON.parse(getReq.res.body);
    expect(body.baseUrl).toContain("%5BREDACTED%5D");
    expect(body.baseUrl).not.toContain("supersecret123");
    expect(body.baseUrl).not.toContain("abc");
  });

  it("POST /v1/providers/:id/probe honors per-account ssrfAllowPrivate setting", async () => {
    await configStore.updateOverlay({
      providers: {
        "local-ollama": {
          adapter: "pi-ai",
          upstreamProvider: "openai",
          baseUrl: "http://127.0.0.1:11434/v1",
          ssrfAllowPrivate: true,
          credential: { kind: "none" },
        } as any,
      },
    }, (await configStore.getOverlay()).revision);

    const probeReq = createMockReqRes(
      "POST",
      "/v1/providers/local-ollama/probe",
      { authorization: `Bearer ${adminKey.rawKey}` },
    );
    await new Promise<void>((resolve) => {
      probeReq.res.on("finish", () => resolve());
      handler(probeReq.req, probeReq.res);
    });
    expect(probeReq.res.statusCode).toBe(200);
    const body = JSON.parse(probeReq.res.body);
    expect(body.providerId).toBe("local-ollama");
    expect(body.blocked).toBeUndefined();
  });

  it("F2 regression: PUT /v1/providers/:id with credential only preserves existing baseUrl, compat, and ssrfAllowPrivate", async () => {
    // 1. Create account with custom endpoint & ssrfAllowPrivate
    await configStore.updateOverlay({
      providers: {
        "custom-ollama": {
          adapter: "pi-ai",
          upstreamProvider: "openai",
          baseUrl: "http://127.0.0.1:11434/v1",
          compat: "openai",
          ssrfAllowPrivate: true,
          credential: { kind: "none" },
        } as any,
      },
    }, (await configStore.getOverlay()).revision);

    const rev = (await configStore.getOverlay()).revision;
    // 2. PUT with only credential (updating API key) without repeating baseUrl
    const putReq = createMockReqRes(
      "PUT",
      "/v1/providers/custom-ollama",
      { authorization: `Bearer ${adminKey.rawKey}`, "if-match": `"${rev}"` },
      JSON.stringify({
        credential: { kind: "api_key", keyValue: "sk-ollama-new" },
      }),
    );
    await new Promise<void>((resolve) => {
      putReq.res.on("finish", () => resolve());
      handler(putReq.req, putReq.res);
    });
    expect(putReq.res.statusCode).toBe(200);

    // 3. Assert overlay preserved baseUrl, compat, ssrfAllowPrivate, and upstreamProvider
    const overlay = await configStore.getOverlay();
    const entry = (overlay.patch.providers as any)?.["custom-ollama"];
    expect(entry).toBeDefined();
    expect(entry.upstreamProvider).toBe("openai");
    expect(entry.baseUrl).toBe("http://127.0.0.1:11434/v1");
    expect(entry.compat).toBe("openai");
    expect(entry.ssrfAllowPrivate).toBe(true);
  });
});
