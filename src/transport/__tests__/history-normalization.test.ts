/**
 * Failed-turn draft resolution, end to end (021-4 W150, revised by review F1).
 *
 * A failed turn persists its user prompt (0.6.1 crash recovery). When the
 * next turn starts, the dangling draft is resolved AT THE SOURCE — the
 * server session store / the SDK in-memory history — so the stored history,
 * the API views, and the model input stay in sync: an identical retry
 * dedupes to one copy; a different prompt supersedes the stale draft.
 */

import { describe, it, expect } from "vitest";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRestHandler, type RestHandlerContext } from "../http/rest.js";
import { ServerSessionManager, hashKey } from "../http/session-store.js";
import { MemoryPersistenceBackend } from "../../domain/sessions/session-store.js";
import { createSeepient } from "../sdk/seepient.js";
import { generateApiKey } from "../auth/auth.js";
import type { Message } from "../../foundations/types.js";
import type { AskSeepientResult } from "../../foundations/types.js";

function msg(role: "user" | "assistant" | "system", content: string): Message {
  return { id: `${role}-${content}`, role, content, timestamp: 0 };
}

function canonicalText(m: any): string {
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    return m.content.map((c: any) => c.text ?? "").join("");
  }
  return m.text ?? "";
}

/** Mock runtime that records canonical model input per call; fails `failNTimes` first calls. */
function recordingRuntime(failNTimes: number) {
  const seenMessages: Array<Array<{ role: string; text: string }>> = [];
  let failures = failNTimes;
  const runtime = {
    createTurnSnapshot: async () => ({
      revision: 1,
      createdAt: new Date().toISOString(),
      catalog: [],
      config: {} as any,
      assignments: {} as any,
    }),
    resolvePlan: async () => ({
      selectedTarget: { providerAccount: "mock", model: "mock-model" } as any,
      failureTargets: [],
    }),
    executeLanguage: async function* (_plan: unknown, req: any) {
      seenMessages.push(req.messages.map((m: any) => ({ role: m.role, text: canonicalText(m) })));
      if (failures > 0) {
        failures--;
        yield {
          type: "error",
          error: { code: "PROVIDER_ERROR", message: "boom", retryable: false },
        };
        return;
      }
      yield { type: "content_block_start", index: 0, block: { type: "text", text: "" } };
      yield {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "recovered" },
      };
      yield { type: "content_block_stop", index: 0 };
    },
  };
  return { runtime, seenMessages };
}

describe("F1 (REST) — draft resolution at the session store", () => {
  const tempFiles: string[] = [];

  function makeKeysFile(): string {
    const p = path.join(os.tmpdir(), `seepient-f1-keys-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    tempFiles.push(p);
    process.env.SEEPIENT_API_KEYS_FILE = p;
    return generateApiKey(["agent:run"], { filePath: p }).rawKey!;
  }

  function mockReq(method: string, url: string, headers: Record<string, string>, body: string): http.IncomingMessage {
    return {
      method,
      url,
      headers,
      on: (event: string, cb: (chunk?: Buffer) => void) => {
        if (event === "data") cb(Buffer.from(body));
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

  it("an identical retry dedupes the dangling draft to one fresh copy", async () => {
    const rawKey = makeKeysFile();
    const backend = new MemoryPersistenceBackend();
    const sessionManager = new ServerSessionManager({ backend });
    const keyHash = hashKey(rawKey);

    // Seed the failed turn's dangling draft directly (as a failed turn would have)
    await sessionManager.createSession(rawKey, { id: "f1-dedupe", apiKeyHash: keyHash });
    sessionManager.addMessage("f1-dedupe", msg("user", "What is the capital of France?"));

    const { seenMessages } = recordingRuntime(0);
    const handler = createRestHandler({
      version: "test",
      startTime: Date.now(),
      sessionManager,
      generateText: async (opts: any) => {
        // History captured AFTER draft resolution: the dangling draft is gone
        expect(opts.history.map((m: Message) => m.role)).toEqual([]);
        return {
          text: "Paris.",
          steps: [], toolCalls: [],
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0 },
          finishReason: "stop", messages: [],
        } as AskSeepientResult;
      },
    } as RestHandlerContext);

    const res = mockRes();
    await handler(
      mockReq("POST", "/v1/chat", {
        "content-type": "application/json",
        authorization: `Bearer ${rawKey}`,
      }, JSON.stringify({ message: "What is the capital of France?", sessionId: "f1-dedupe" })),
      res as unknown as http.ServerResponse,
    );

    expect(res.statusCode).toBe(200);
    // Store: exactly ONE user row (deduped), no back-to-back user bubbles
    const stored = await backend.load("f1-dedupe") as unknown as { messages: Message[] };
    expect(stored.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(stored.messages.filter((m) => m.content === "What is the capital of France?")).toHaveLength(1);
    void seenMessages;
  });

  it("a different follow-up prompt supersedes the stale draft", async () => {
    const rawKey = makeKeysFile();
    const backend = new MemoryPersistenceBackend();
    const sessionManager = new ServerSessionManager({ backend });
    const keyHash = hashKey(rawKey);

    await sessionManager.createSession(rawKey, { id: "f1-supersede", apiKeyHash: keyHash });
    sessionManager.addMessage("f1-supersede", msg("user", "Run the deploy"));

    let capturedHistory: Message[] = [];
    const handler = createRestHandler({
      version: "test",
      startTime: Date.now(),
      sessionManager,
      generateText: async (opts: any) => {
        capturedHistory = opts.history;
        return {
          text: "It failed because X.",
          steps: [], toolCalls: [],
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0 },
          finishReason: "stop", messages: [],
        } as AskSeepientResult;
      },
    } as RestHandlerContext);

    const res = mockRes();
    await handler(
      mockReq("POST", "/v1/chat", {
        "content-type": "application/json",
        authorization: `Bearer ${rawKey}`,
      }, JSON.stringify({ message: "Why did the deploy fail?", sessionId: "f1-supersede" })),
      res as unknown as http.ServerResponse,
    );

    expect(res.statusCode).toBe(200);
    // History captured AFTER resolution: the stale draft is gone
    expect(capturedHistory.map((m) => m.role)).toEqual([]);
    // Store: the new prompt replaced the draft — one user row, one assistant row
    const stored = await backend.load("f1-supersede") as unknown as { messages: Message[] };
    expect(stored.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(stored.messages[0].content).toBe("Why did the deploy fail?");
  });
});

describe("F1 (SDK) — draft resolution in createSeepient", () => {
  it("an identical retry dedupes; the model input alternates with the text once", async () => {
    const { runtime, seenMessages } = recordingRuntime(1);
    const agent = await createSeepient({
      runtime: runtime as any,
      persist: new MemoryPersistenceBackend(),
      tools: [],
      skills: false,
    });

    await expect(agent.chat("Hello there")).rejects.toThrow(/boom/);
    expect(agent.getHistory().filter((m: Message) => m.role === "user")).toHaveLength(1);

    const reply = await agent.chat("Hello there");
    expect(reply.text).toBe("recovered");

    const turn2 = seenMessages[1];
    expect(turn2.map((m) => m.role)).toEqual(["system", "user"]);
    expect(turn2.filter((m) => m.text === "Hello there")).toHaveLength(1);
    // In-memory history resolved: no duplicate rows
    expect(agent.getHistory().filter((m: Message) => m.role === "user")).toHaveLength(1);
  });

  it("a different follow-up supersedes the failed draft", async () => {
    const { runtime, seenMessages } = recordingRuntime(1);
    const agent = await createSeepient({
      runtime: runtime as any,
      persist: new MemoryPersistenceBackend(),
      tools: [],
      skills: false,
    });

    await expect(agent.chat("Run the deploy")).rejects.toThrow(/boom/);
    const reply = await agent.chat("Why did it fail?");
    expect(reply.text).toBe("recovered");

    const turn2 = seenMessages[1];
    expect(turn2.map((m) => m.role)).toEqual(["system", "user"]);
    expect(turn2[1].text).toBe("Why did it fail?");
    expect(turn2.some((m) => m.text === "Run the deploy")).toBe(false);
    expect(agent.getHistory().filter((m: Message) => m.role === "user")).toHaveLength(1);
  });

  it("a resumed session with a legacy mid-history pair still merges at send time", async () => {
    const backend = new MemoryPersistenceBackend();
    // Legacy session: pre-021-4 store with consecutive user messages
    await backend.save("legacy-pair", {
      id: "legacy-pair",
      messages: [msg("user", "a"), msg("user", "b"), msg("assistant", "ok")],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      principalId: "sdk-user",
    });

    const { runtime, seenMessages } = recordingRuntime(0);
    const agent = await createSeepient({
      runtime: runtime as any,
      persist: backend,
      sessionId: "legacy-pair",
      tools: [],
      skills: false,
    });

    await agent.chat("next");
    const turn1 = seenMessages[0];
    expect(turn1.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(turn1[1].text).toBe("a\n\nb");
  });
});
