/**
 * WS scope-model enforcement (021-4 W140).
 *
 * REST chat requires `agent:run` and session reads require `agent:read`;
 * the WebSocket handlers must enforce the same scope model — a key minted
 * with only provider scopes must get a FORBIDDEN error frame on chat,
 * resume, and reconnect instead of streaming agent turns or reading
 * session histories.
 */

import { describe, it, expect, vi } from "vitest";
import { handleChat } from "../chat.js";
import { handleResume, handleReconnect } from "../session-control.js";
import { createConnectionRegistry } from "../connection-registry.js";
import type {
  WebSocket,
  ChatMessage,
  ResumeMessage,
  ReconnectMessage,
  WebSocketHandlerContext,
  ConnectionState,
} from "../ws-types.js";
import type { ApiKeyEntry, KeyScope } from "../../auth/auth.js";
import { ServerSessionManager } from "../../http/session-store.js";
import { MemoryPersistenceBackend } from "../../../domain/sessions/session-store.js";

function createMockWs() {
  const sent: any[] = [];
  const ws = {
    send: (data: string) => sent.push(JSON.parse(data)),
    readyState: 1,
    close: vi.fn(),
    on: vi.fn(),
    ping: vi.fn(),
  } as unknown as WebSocket;
  return { ws, sent };
}

function makeState(scopes: KeyScope[]): ConnectionState {
  const apiKey: ApiKeyEntry = {
    keyHash: "test-key-hash",
    scopes,
    created: new Date().toISOString(),
    label: "scope-test",
  };
  return {
    sessionId: null,
    activeChats: new Set(),
    activeProvider: null,
    activeModel: null,
    apiKeyHash: apiKey.keyHash,
    apiKey,
  };
}

function makeCtx(): WebSocketHandlerContext {
  return {
    registry: createConnectionRegistry(),
    sessionManager: new ServerSessionManager({ backend: new MemoryPersistenceBackend() }),
    streamText: vi.fn(),
    listModels: () => ({}),
    listSkills: () => [],
  };
}

describe("W140 — WS handlers enforce the REST scope model", () => {
  it("chat with a provider-scoped key gets a FORBIDDEN frame and never reaches streamText", async () => {
    const { ws, sent } = createMockWs();
    const ctx = makeCtx();
    const state = makeState(["provider:read", "provider:admin"]);
    const msg: ChatMessage = { type: "chat", id: "m1", message: "hello" };

    await handleChat(ws, msg, state, ctx);

    expect(ctx.streamText).not.toHaveBeenCalled();
    const err = sent.find((f) => f.type === "error");
    expect(err).toBeDefined();
    expect(err.code).toBe("FORBIDDEN");
    expect(err.message).toContain("agent:run");
  });

  it("resume with a provider-scoped key gets a FORBIDDEN frame", async () => {
    const { ws, sent } = createMockWs();
    const ctx = makeCtx();
    const state = makeState(["provider:read"]);
    const msg: ResumeMessage = { type: "resume", sessionId: "some-session" };

    await handleResume(ws, msg, state, ctx);

    const err = sent.find((f) => f.type === "error");
    expect(err).toBeDefined();
    expect(err.code).toBe("FORBIDDEN");
    expect(err.message).toContain("agent:read");
  });

  it("reconnect with a provider-scoped key gets a FORBIDDEN frame", async () => {
    const { ws, sent } = createMockWs();
    const ctx = makeCtx();
    const state = makeState(["provider:read"]);
    const msg: ReconnectMessage = { type: "reconnect", sessionId: "some-session" };

    await handleReconnect(ws, msg, state, ctx);

    const err = sent.find((f) => f.type === "error");
    expect(err).toBeDefined();
    expect(err.code).toBe("FORBIDDEN");
    expect(err.message).toContain("agent:read");
  });

  it("chat with an agent:run key passes the scope gate and reaches streamText", async () => {
    const { ws, sent } = createMockWs();
    const ctx = makeCtx();
    ctx.streamText = vi.fn((opts: any) => {
      opts.onDone({
        text: "ok",
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0 },
        finishReason: "stop",
      });
    });
    const state = makeState(["agent:run"]);
    const msg: ChatMessage = { type: "chat", id: "m1", message: "hello" };

    await handleChat(ws, msg, state, ctx);

    expect(ctx.streamText).toHaveBeenCalledTimes(1);
    expect(sent.find((f) => f.type === "error")).toBeUndefined();
  });

  it("resume with an agent:read key passes the scope gate", async () => {
    const { ws, sent } = createMockWs();
    const ctx = makeCtx();
    const state = makeState(["agent:read"]);
    const msg: ResumeMessage = { type: "resume", sessionId: "missing-session" };

    await handleResume(ws, msg, state, ctx);

    // Past the scope gate: the failure (if any) is about the session, not scope
    const err = sent.find((f) => f.type === "error");
    if (err) {
      expect(err.code).not.toBe("FORBIDDEN");
    }
  });
});
