import { describe, it, expect } from "vitest";
import { createSessionRegistry } from "../session-registry.js";
import { MemoryPersistenceBackend } from "../session-store.js";
import type { Message, SessionData } from "../types.js";

function userMsg(content: string, authorId?: string): Message {
  return {
    id: `m-${content}`,
    role: "user",
    content,
    timestamp: Date.now(),
    ...(authorId ? { authorId, authorName: authorId } : {}),
  };
}

function withIdentity(over?: Partial<SessionData>): Partial<SessionData> {
  return {
    platform: "telegram",
    conversationId: "chat-1",
    ...over,
  };
}

describe("SessionRegistry", () => {
  it("resolveSession creates a session on first call, loads on second", async () => {
    const backend = new MemoryPersistenceBackend();
    const registry = createSessionRegistry(backend);

    const s1 = await registry.resolveSession(withIdentity() as any);
    expect(s1.id).toBeTruthy();
    expect(s1.platform).toBe("telegram");
    expect(s1.conversationId).toBe("chat-1");
    expect(s1.messages).toEqual([]);

    const s2 = await registry.resolveSession(withIdentity() as any);
    expect(s2.id).toBe(s1.id);
  });

  it("distinguishes conversations by platform/conversationId/botId", async () => {
    const registry = createSessionRegistry(new MemoryPersistenceBackend());

    const a = await registry.resolveSession({ platform: "telegram", conversationId: "1" });
    const b = await registry.resolveSession({ platform: "telegram", conversationId: "2" });
    const c = await registry.resolveSession({ platform: "discord", conversationId: "1" });
    const d = await registry.resolveSession({ platform: "telegram", conversationId: "1", botId: "bot-b" });

    expect(new Set([a.id, b.id, c.id, d.id]).size).toBe(4);
  });

  it("sessionsForUser returns all sessions for a canonical userId", async () => {
    const backend = new MemoryPersistenceBackend();
    const registry = createSessionRegistry(backend);

    // Two conversations, same canonical user.
    const s1 = await registry.resolveSession({ platform: "telegram", conversationId: "c1" });
    const s2 = await registry.resolveSession({ platform: "telegram", conversationId: "c2" });
    s1.userId = "user-42";
    s2.userId = "user-42";
    await registry.save(s1);
    await registry.save(s2);

    const sessions = await registry.sessionsForUser("user-42");
    expect(sessions.map((s) => s.id).sort()).toEqual([s1.id, s2.id].sort());
    expect(await registry.sessionsForUser("nobody")).toEqual([]);
  });

  it("appendMessage persists and emits a messageAppended event", async () => {
    const registry = createSessionRegistry(new MemoryPersistenceBackend());
    const events: string[] = [];
    registry.on("messageAppended", (e) => events.push(`${e.sessionId}:${e.message?.content}`));

    const session = await registry.resolveSession({ platform: "telegram", conversationId: "c" });
    const msg = userMsg("hello", "user-1");
    await registry.appendMessage(session.id, msg);

    const reloaded = await registry.resolveSession({ platform: "telegram", conversationId: "c" });
    expect(reloaded.messages).toHaveLength(1);
    expect(reloaded.messages[0].content).toBe("hello");
    expect(events).toEqual([`${session.id}:hello`]);
  });

  it("save emits a sessionSaved event with the userId", async () => {
    const registry = createSessionRegistry(new MemoryPersistenceBackend());
    let saved: { sessionId: string; userId?: string } | null = null;
    registry.on("sessionSaved", (e) => { saved = { sessionId: e.sessionId, userId: e.userId }; });

    const session = await registry.resolveSession({ platform: "telegram", conversationId: "c" });
    session.userId = "user-9";
    await registry.save(session);

    expect(saved).not.toBeNull();
    expect(saved!.sessionId).toBe(session.id);
    expect(saved!.userId).toBe("user-9");
  });

  it("rebuilds indexes from backend.list() on startup", async () => {
    const backend = new MemoryPersistenceBackend();

    // Seed the backend with a session that has identity, BEFORE the registry
    // exists (simulates a restart with persisted sessions).
    const persisted: SessionData = {
      id: "preexisting-1",
      messages: [userMsg("old")],
      createdAt: 1,
      updatedAt: 2,
      platform: "telegram",
      conversationId: "rebuilt-chat",
      userId: "user-rebuild",
    };
    await backend.save(persisted.id, persisted);

    // A fresh registry should pick up the pre-existing session via the index.
    const registry = createSessionRegistry(backend);
    const resolved = await registry.resolveSession({ platform: "telegram", conversationId: "rebuilt-chat" });
    expect(resolved.id).toBe("preexisting-1");
    expect(resolved.messages[0].content).toBe("old");

    // And sessionsForUser should see it too.
    const forUser = await registry.sessionsForUser("user-rebuild");
    expect(forUser.map((s) => s.id)).toEqual(["preexisting-1"]);
  });

  it("concurrent resolveSession calls for the same identity return the same session", async () => {
    const registry = createSessionRegistry(new MemoryPersistenceBackend());

    const [a, b, c] = await Promise.all([
      registry.resolveSession({ platform: "telegram", conversationId: "race" }),
      registry.resolveSession({ platform: "telegram", conversationId: "race" }),
      registry.resolveSession({ platform: "telegram", conversationId: "race" }),
    ]);

    expect(a.id).toBe(b.id);
    expect(b.id).toBe(c.id);
  });

  it("delete removes the session and its index entries", async () => {
    const registry = createSessionRegistry(new MemoryPersistenceBackend());
    const session = await registry.resolveSession({ platform: "telegram", conversationId: "gone" });
    session.userId = "user-del";
    await registry.save(session);

    await registry.delete(session.id);

    // A fresh resolveSession creates a NEW session (the old index entry is gone).
    const recreated = await registry.resolveSession({ platform: "telegram", conversationId: "gone" });
    expect(recreated.id).not.toBe(session.id);
    expect(await registry.sessionsForUser("user-del")).toEqual([]);
  });

  it("unsubscribes event handlers via the returned disposer", async () => {
    const registry = createSessionRegistry(new MemoryPersistenceBackend());
    const calls: string[] = [];
    const off = registry.on("messageAppended", (e) => calls.push(e.message?.content ?? ""));
    off();

    const session = await registry.resolveSession({ platform: "telegram", conversationId: "c" });
    await registry.appendMessage(session.id, userMsg("ignored"));
    expect(calls).toEqual([]);
  });
});
