import { describe, it, expect, vi } from "vitest";
import { handleWsListProviders } from "../ws-handlers.js";
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
      id: "conn-1",
      authenticated: true,
      apiKey: {
        rawKey: "test-key",
        label: "test",
        scopes: ["agent:read", "provider:read"],
        createdAt: new Date().toISOString(),
      },
      createdAt: Date.now(),
      lastPing: Date.now(),
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
      id: "conn-2",
      authenticated: true,
      apiKey: {
        rawKey: "test-key-no-scope",
        label: "test",
        scopes: [],
        createdAt: new Date().toISOString(),
      },
      createdAt: Date.now(),
      lastPing: Date.now(),
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
    const { handleWsRemoveProvider } = await import("../ws-handlers.js");
    const messages: any[] = [];
    const mockWs: WebSocket = {
      readyState: 1,
      send: (data: string) => { messages.push(JSON.parse(data)); },
    } as any;

    const state: ConnectionState = {
      id: "conn-no-admin",
      authenticated: true,
      apiKey: { rawKey: "k", label: "test", scopes: ["provider:read"], createdAt: new Date().toISOString() },
      createdAt: Date.now(),
      lastPing: Date.now(),
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
