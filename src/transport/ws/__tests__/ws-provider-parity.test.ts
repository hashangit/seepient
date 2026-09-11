import { describe, it, expect, vi } from "vitest";
import { handleWsListProviders } from "../provider-mutations.js";
import type { ConnectionState, WebSocket } from "../ws-types.js";

describe("WS Provider Parity (FR-040 / T057)", () => {
  it("handleWsListProviders responds with configured accounts when authorized", async () => {
    const { ProviderRuntime } = await import("../../../domain/providers/provider-runtime.js");
    const { ProviderConfigStore } = await import("../../../domain/providers/config-store/provider-config-store.js");
    const { MemoryCredentialStore } = await import("../../../domain/providers/credentials/memory-credential-store.js");
    const { AggregateInferenceAdapter } = await import("../../../capabilities/inference/aggregate-adapter.js");

    const runtime = new ProviderRuntime({
      configStore: new ProviderConfigStore(":memory:"),
      credentialStore: new MemoryCredentialStore(),
      adapter: new AggregateInferenceAdapter({}),
    });

    const messages: any[] = [];
    const mockWs: WebSocket = {
      readyState: 1,
      send: (data: string) => {
        messages.push(JSON.parse(data));
      },
      close: vi.fn(),
      on: vi.fn(),
      ping: vi.fn(),
      terminate: vi.fn(),
    } as any;

    const state: ConnectionState = {
      sessionId: null,
      activeChats: new Set(),
      activeProvider: null,
      activeModel: null,
      apiKeyHash: "hash-1",
      apiKey: {
        keyHash: "hash-1",
        rawKey: "test-key",
        label: "test",
        scopes: ["agent:read", "provider:read"],
        created: new Date().toISOString(),
      },
    };

    await handleWsListProviders(
      { type: "list_providers", id: "req-1" } as any,
      mockWs,
      state,
      { runtime } as any,
    );

    expect(messages.length).toBe(1);
    expect(messages[0].type).toBe("providers_list");
    expect(messages[0].id).toBe("req-1");
    expect(messages[0].providers).toBeDefined();
  });

  it("handleWsListProviders rejects when lacking scope", async () => {
    const messages: any[] = [];
    const mockWs: WebSocket = {
      readyState: 1,
      send: (data: string) => {
        messages.push(JSON.parse(data));
      },
      close: vi.fn(),
      on: vi.fn(),
      ping: vi.fn(),
      terminate: vi.fn(),
    } as any;

    const state: ConnectionState = {
      sessionId: null,
      activeChats: new Set(),
      activeProvider: null,
      activeModel: null,
      apiKeyHash: "hash-2",
      apiKey: {
        keyHash: "hash-2",
        rawKey: "test-key-no-scope",
        label: "test",
        scopes: [],
        created: new Date().toISOString(),
      },
    };

    await handleWsListProviders(
      { type: "list_providers", id: "req-2" } as any,
      mockWs,
      state,
      {} as any,
    );

    expect(messages.length).toBe(1);
    expect(messages[0].error?.code).toBe("FORBIDDEN");
  });

  it("handleWsRemoveProvider enforces scope check", async () => {
    const { handleWsRemoveProvider } = await import("../provider-mutations.js");
    const messages: any[] = [];
    const mockWs: WebSocket = {
      readyState: 1,
      send: (data: string) => { messages.push(JSON.parse(data)); },
    } as any;

    const state: ConnectionState = {
      sessionId: null,
      activeChats: new Set(),
      activeProvider: null,
      activeModel: null,
      apiKeyHash: "hash-3",
      apiKey: { keyHash: "hash-3", rawKey: "k", label: "test", scopes: ["provider:read"], created: new Date().toISOString() },
    };

    await handleWsRemoveProvider(
      { type: "settings_updated", id: "req-rem-1", providerType: "anthropic" } as any,
      mockWs,
      state,
      {} as any,
    );

    expect(messages.length).toBe(1);
    expect(messages[0].error?.code).toBe("FORBIDDEN");
  });

  it("injected runtime observes identical mutations across REST and WS (FR-027)", async () => {
    const { ProviderRuntime } = await import("../../../domain/providers/provider-runtime.js");
    const { ProviderConfigStore } = await import("../../../domain/providers/config-store/provider-config-store.js");
    const { MemoryCredentialStore } = await import("../../../domain/providers/credentials/memory-credential-store.js");
    const { AggregateInferenceAdapter } = await import("../../../capabilities/inference/aggregate-adapter.js");
    const { handleWsSetProvider } = await import("../provider-mutations.js");
    const { createRestHandler } = await import("../../http/rest.js");
    const { ServerSessionManager } = await import("../../http/session-store.js");
    const { MemoryPersistenceBackend } = await import("../../../domain/sessions/session-store.js");
    const { generateApiKey } = await import("../../auth/auth.js");
    const { Readable } = await import("node:stream");
    const { EventEmitter } = await import("node:events");
    const os = await import("node:os");
    const path = await import("node:path");
    const fs = await import("node:fs");

    const tempKeyPath = path.join(os.tmpdir(), `seepient-provider-keys-${Date.now()}.json`);
    process.env.SEEPIENT_API_KEYS_FILE = tempKeyPath;
    const rawKey = generateApiKey(["agent:run", "agent:read", "provider:admin", "provider:read"], { filePath: tempKeyPath }).rawKey!;

    const sharedRuntime = new ProviderRuntime({
      configStore: new ProviderConfigStore(":memory:"),
      credentialStore: new MemoryCredentialStore(),
      adapter: new AggregateInferenceAdapter({}),
    });

    // 1. Create account via WS on sharedRuntime
    const wsMessages: any[] = [];
    const mockWs: any = {
      readyState: 1,
      send: (data: string) => { wsMessages.push(JSON.parse(data)); },
    };
    const wsState: any = {
      sessionId: null,
      activeChats: new Set(),
      apiKeyHash: "test-hash",
      apiKey: { scopes: ["provider:admin", "provider:read"] },
    };

    await handleWsSetProvider(
      {
        type: "set_provider",
        id: "ws-add-1",
        provider: { type: "openai", apiKey: "sk-test" },
      },
      mockWs,
      wsState,
      { runtime: sharedRuntime } as any,
    );

    const updateFrame = wsMessages.find((m) => m.type === "settings_updated");
    expect(updateFrame).toBeDefined();
    expect(updateFrame.applied?.openai).toBe(true);

    // 2. Query accounts via REST handler configured with sharedRuntime
    const restCtx: any = {
      version: "0.8.0",
      startTime: Date.now(),
      sessionManager: new ServerSessionManager({ backend: new MemoryPersistenceBackend() }),
      runtime: sharedRuntime,
      listModels: () => ({}),
      listSkills: () => [],
    };
    const restHandler = createRestHandler(restCtx);

    const req = Readable.from([]) as any;
    req.method = "GET";
    req.url = "/v1/providers";
    req.headers = { authorization: `Bearer ${rawKey}` };

    const res = new EventEmitter() as any;
    res.statusCode = 200;
    res.headers = {};
    res.body = "";
    res.setHeader = (k: string, v: string) => { res.headers[k.toLowerCase()] = v; };
    res.writeHead = (code: number, headers?: any) => { res.statusCode = code; };
    res.end = (data?: string) => {
      if (data) res.body += data;
      res.emit("finish");
    };

    await new Promise<void>((resolve) => {
      res.on("finish", resolve);
      restHandler(req, res);
    });

    expect(res.statusCode).toBe(200);
    const restData = JSON.parse(res.body);
    // REST sees the account created via WS on the shared runtime
    expect(restData["openai"]).toBeDefined();
    expect(restData["openai"].upstreamProvider).toBe("openai");

    try {
      fs.unlinkSync(tempKeyPath);
    } catch {}
  });
});
