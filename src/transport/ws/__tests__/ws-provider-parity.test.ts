import { describe, it, expect, vi } from "vitest";
import { handleWsListProviders } from "../provider-mutations.js";
import type { ConnectionState, WebSocket } from "../ws-types.js";

describe("WS Provider Parity (FR-040 / T057)", () => {
  it("handleWsListProviders responds with configured accounts when authorized", async () => {
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
      currentAbortController: null,
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
      {} as any,
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
      currentAbortController: null,
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
      currentAbortController: null,
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
});
