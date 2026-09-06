/**
 * WS session fixes (021-4 W154d/e).
 *
 * W154d — a busy-reject must not re-pin the connection to the session.
 * W154e — fire-and-forget resume/reconnect dispatches carry .catch mirrors
 *         so a rejection becomes an INTERNAL_ERROR frame, not a crash.
 */

import { describe, it, expect, vi } from "vitest";
import { handleChat } from "../chat.js";
import { handleConnection } from "../ws-handlers.js";

// W154e: simulate a resume handler that rejects — the dispatcher's .catch
// mirror must convert the rejection into an INTERNAL_ERROR frame.
vi.mock("../session-control.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../session-control.js")>();
  return {
    ...actual,
    handleResume: async () => {
      throw new Error("resume exploded");
    },
  };
});
import { createConnectionRegistry } from "../connection-registry.js";
import { ServerSessionManager } from "../../http/session-store.js";
import { MemoryPersistenceBackend } from "../../../domain/sessions/session-store.js";
import { generateApiKey } from "../../auth/auth.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  WebSocket,
  ChatMessage,
  WebSocketHandlerContext,
  ConnectionState,
} from "../ws-types.js";
import type { ApiKeyEntry } from "../../auth/auth.js";

function createMockWs() {
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

function makeState(scopes: ApiKeyEntry["scopes"]): ConnectionState {
  const apiKey: ApiKeyEntry = {
    keyHash: "ws-fixes-hash",
    scopes,
    created: new Date().toISOString(),
    label: "ws-session-fixes",
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

describe("W154d — busy-reject does not re-pin the connection", () => {
  it("state.sessionId stays null when the session turn lock is held elsewhere", async () => {
    const { ws, sent } = createMockWs();
    const ctx = makeCtx();

    // Create the session and hold its turn lock (as if another writer is live)
    await ctx.sessionManager.createSession("raw-owner-key", {
      id: "w154d-busy",
      apiKeyHash: "ws-fixes-hash",
    });
    expect(ctx.sessionManager.acquireTurn("w154d-busy")).toBe(true);

    const state = makeState(["agent:run"]);
    const msg: ChatMessage = { type: "chat", id: "m1", message: "hello", sessionId: "w154d-busy" };

    await handleChat(ws, msg, state, ctx);

    expect(state.sessionId).toBeNull();
    const err = sent.find((f) => f.type === "error");
    expect(err?.code).toBe("REQUEST_IN_FLIGHT");
  });
});

describe("W154e — resume/reconnect dispatch carries a .catch mirror", () => {
  it("a rejecting resume handler produces an INTERNAL_ERROR frame instead of an unhandled rejection", async () => {
    const rawKeyPath = path.join(os.tmpdir(), `seepient-wsfix-keys-${Date.now()}.json`);
    process.env.SEEPIENT_API_KEYS_FILE = rawKeyPath;
    const rawKey = generateApiKey(["agent:run", "agent:read"], { filePath: rawKeyPath }).rawKey!;

    try {
      const { ws, sent, handlers } = createMockWs();
      const ctx = makeCtx();

      handleConnection(ws, { headers: { authorization: `Bearer ${rawKey}` } } as any, ctx);
      const onMessage = handlers.get("message")!;

      onMessage(Buffer.from(JSON.stringify({ type: "resume", sessionId: "whatever" })));
      // Drive the event loop so the async handler + mirror resolve
      await new Promise((resolve) => setTimeout(resolve, 10));

      const err = sent.find((f) => f.type === "error");
      expect(err).toBeDefined();
      expect(err.code).toBe("INTERNAL_ERROR");
      // W162: the frame carries generic text; the raw detail is logged only.
      expect(err.message).toBe("Internal server error");
    } finally {
      if (fs.existsSync(rawKeyPath)) fs.unlinkSync(rawKeyPath);
    }
  });
});
