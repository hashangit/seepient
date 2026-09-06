/**
 * Session integrity tests (021-4 W151/W152/W153/W154a/b).
 *
 * W151 — a resolved `finishReason:"error"` turn must not persist an empty
 *        assistant row and must answer 502, not 200.
 * W152 — the absolute TTL must not evict a session with an in-flight turn;
 *        expiry checks happen after ownership; deleteSession refuses while
 *        a turn is live.
 * W153 — a denied cross-key probe must not cache the victim's session.
 * W154 — sessionId charset/length alignment.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { generateApiKey } from "../../auth/auth.js";
import { createRestHandler, type RestHandlerContext } from "../rest.js";
import { ServerSessionManager, hashKey } from "../session-store.js";
import { MemoryPersistenceBackend } from "../../../domain/sessions/session-store.js";
import type { SessionData } from "../../../foundations/types.js";
import type { AskSeepientResult } from "../../../foundations/types.js";

function makeCtx(sessionManager: ServerSessionManager, generateText: RestHandlerContext["generateText"]): RestHandlerContext {
  return {
    version: "test",
    startTime: Date.now(),
    sessionManager,
    generateText,
    listModels: () => ({}),
    listSkills: () => [],
  };
}

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

function mockRes(): http.ServerResponse & { body: string; statusCode?: number } {
  const state = { body: "", statusCode: undefined as number | undefined };
  const res = {
    writeHead(code: number) {
      state.statusCode = code;
      return res;
    },
    setHeader() {},
    end(chunk?: string) {
      if (chunk) state.body += chunk;
    },
    on(_event: string, cb: () => void) {
      cb();
      return res;
    },
    get statusCode() {
      return state.statusCode;
    },
    get body() {
      return state.body;
    },
    headers: {} as Record<string, string>,
  } as unknown as http.ServerResponse & { body: string; statusCode?: number };
  return res;
}

const OWNER_KEY = "owner-raw-key";
const OWNER_HASH = "a".repeat(64); // matches hashKey shape for tests
const FOREIGN_HASH = "b".repeat(64);

let ownerRawKey = "";
let tempKeyPath = "";

beforeEach(() => {
  tempKeyPath = path.join(os.tmpdir(), `seepient-integrity-keys-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  process.env.SEEPIENT_API_KEYS_FILE = tempKeyPath;
  ownerRawKey = generateApiKey(["agent:run"], { filePath: tempKeyPath }).rawKey!;
});

afterEach(() => {
  if (fs.existsSync(tempKeyPath)) fs.unlinkSync(tempKeyPath);
});

describe("W151 — resolved-error turns persist no assistant row (REST)", () => {
  it("returns 502 and stores no assistant message when the loop resolves with finishReason error", async () => {
    const backend = new MemoryPersistenceBackend();
    const sessionManager = new ServerSessionManager({ backend, maxSessionsPerKey: 10 });
    const session = await sessionManager.createSession(OWNER_KEY, {
      id: "w151-rest-session",
      apiKeyHash: hashKey(ownerRawKey),
    });

    const handler = createRestHandler(
      makeCtx(sessionManager, async (): Promise<AskSeepientResult> => ({
        text: "",
        steps: [],
        toolCalls: [],
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0 },
        finishReason: "error",
        messages: [],
      })),
    );

    const res = mockRes();
    await handler(
      mockReq("POST", "/v1/chat", {
        "content-type": "application/json",
        authorization: `Bearer ${ownerRawKey}`,
      }, JSON.stringify({
        message: "hello",
        sessionId: "w151-rest-session",
      })),
      res as unknown as http.ServerResponse,
    );

    expect(res.statusCode).toBe(502);

    // No assistant row: only the persisted user message exists
    const stored = await backend.load("w151-rest-session") as unknown as SessionData;
    const roles = stored.messages.map((m) => m.role);
    expect(roles).toEqual(["user"]);
  });

  it("a successful turn still persists the assistant row and returns 200", async () => {
    const backend = new MemoryPersistenceBackend();
    const sessionManager = new ServerSessionManager({ backend, maxSessionsPerKey: 10 });
    await sessionManager.createSession(OWNER_KEY, {
      id: "w151-rest-ok",
      apiKeyHash: hashKey(ownerRawKey),
    });

    const handler = createRestHandler(
      makeCtx(sessionManager, async (): Promise<AskSeepientResult> => ({
        text: "the answer",
        steps: [],
        toolCalls: [],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, cost: 0 },
        finishReason: "stop",
        messages: [],
      })),
    );

    const res = mockRes();
    await handler(
      mockReq("POST", "/v1/chat", {
        "content-type": "application/json",
        authorization: `Bearer ${ownerRawKey}`,
      }, JSON.stringify({
        message: "hello",
        sessionId: "w151-rest-ok",
      })),
      res as unknown as http.ServerResponse,
    );

    expect(res.statusCode).toBe(200);
    const stored = await backend.load("w151-rest-ok") as unknown as SessionData;
    const roles = stored.messages.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant"]);
  });
});

describe("W152 — eviction cannot clear a live writer lock", () => {
  it("an absolutely-expired session with an in-flight turn survives getSession", async () => {
    const sessionManager = new ServerSessionManager({
      backend: new MemoryPersistenceBackend(),
      sessionTTL: -1, // always absolutely expired unless a turn defers it
    });
    await sessionManager.createSession(OWNER_KEY, {
      id: "w152-live-lock",
      apiKeyHash: OWNER_HASH,
    });
    expect(sessionManager.acquireTurn("w152-live-lock")).toBe(true);

    // Owner probe: expiry is deferred while the turn is in flight
    const session = await sessionManager.getSession("w152-live-lock", OWNER_HASH);
    expect(session).not.toBeNull();

    // Foreign probe: denied on ownership — and must NOT delete the session
    // or clear the writer lock (the old order deleted expired sessions before
    // ownership verification).
    const foreign = await sessionManager.getSession("w152-live-lock", FOREIGN_HASH);
    expect(foreign).toBeNull();

    // The lock is still held and the session still exists for the owner
    expect(sessionManager.isTurnInFlight("w152-live-lock")).toBe(true);
    expect(await sessionManager.getSession("w152-live-lock", OWNER_HASH)).not.toBeNull();
    expect(sessionManager.acquireTurn("w152-live-lock")).toBe(false);

    sessionManager.releaseTurn("w152-live-lock");
  });

  it("an absolutely-expired session without a live turn is still collected", async () => {
    const sessionManager = new ServerSessionManager({
      backend: new MemoryPersistenceBackend(),
      sessionTTL: -1,
    });
    await sessionManager.createSession(OWNER_KEY, {
      id: "w152-expired-gone",
      apiKeyHash: OWNER_HASH,
    });

    expect(await sessionManager.getSession("w152-expired-gone", OWNER_HASH)).toBeNull();
  });

  it("deleteSession refuses while a turn is in flight", async () => {
    const backend = new MemoryPersistenceBackend();
    const sessionManager = new ServerSessionManager({ backend });
    await sessionManager.createSession(OWNER_KEY, {
      id: "w152-delete-guard",
      apiKeyHash: OWNER_HASH,
    });
    sessionManager.acquireTurn("w152-delete-guard");

    sessionManager.deleteSession("w152-delete-guard");
    expect(sessionManager.isTurnInFlight("w152-delete-guard")).toBe(true);
    expect(await sessionManager.getSession("w152-delete-guard", OWNER_HASH)).not.toBeNull();

    sessionManager.releaseTurn("w152-delete-guard");
    sessionManager.deleteSession("w152-delete-guard");
    expect(await sessionManager.getSession("w152-delete-guard", OWNER_HASH)).toBeNull();
  });
});

describe("W153 — denied probes must not cache the victim's session", () => {
  it("a foreign probe leaves the resident map empty and the victim unpinned", async () => {
    const backend = new MemoryPersistenceBackend();
    const victimManager = new ServerSessionManager({ backend });
    await victimManager.createSession(OWNER_KEY, {
      id: "w153-victim",
      apiKeyHash: OWNER_HASH,
    });

    // A second manager over the same backend: the victim session exists only
    // in the backend, not in this manager's resident map.
    const probingManager = new ServerSessionManager({ backend });
    const denied = await probingManager.getSession("w153-victim", FOREIGN_HASH);
    expect(denied).toBeNull();
    expect(probingManager.getActiveSessions()).toHaveLength(0);

    // The owner's probe succeeds and only then takes up residency
    const owned = await probingManager.getSession("w153-victim", OWNER_HASH);
    expect(owned).not.toBeNull();
    expect(probingManager.getActiveSessions()).toHaveLength(1);
  });
});

describe("W154a/b — sessionId charset and length alignment", () => {
  let keyPathOrigin: string | undefined;

  beforeEach(() => {
    keyPathOrigin = process.env.SEEPIENT_API_KEYS_FILE;
  });
  afterEach(() => {
    if (keyPathOrigin !== undefined) process.env.SEEPIENT_API_KEYS_FILE = keyPathOrigin;
    else delete process.env.SEEPIENT_API_KEYS_FILE;
  });

  it("underscores are accepted everywhere", async () => {
    const sessionManager = new ServerSessionManager({ backend: new MemoryPersistenceBackend() });
    const s = await sessionManager.createSession(OWNER_KEY, {
      id: "tenant_9f2-session",
      apiKeyHash: OWNER_HASH,
    });
    expect(s.id).toBe("tenant_9f2-session");
  });

  it("ids over 128 characters are refused", async () => {
    const sessionManager = new ServerSessionManager({ backend: new MemoryPersistenceBackend() });
    const longId = "a".repeat(129);
    await expect(
      sessionManager.createSession(OWNER_KEY, { id: longId, apiKeyHash: OWNER_HASH }),
    ).rejects.toThrow(/Invalid session ID format/);

    const okId = "a".repeat(128);
    const ok = await sessionManager.createSession(OWNER_KEY, { id: okId, apiKeyHash: OWNER_HASH });
    expect(ok.id).toBe(okId);
  });
});
