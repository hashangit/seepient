import { describe, it, expect } from "vitest";
import { ServerSessionManager } from "../session-store.js";
import { MemoryPersistenceBackend } from "../../../domain/sessions/session-store.js";
import type { Message } from "../../../foundations/types.js";

describe("ServerSessionManager (Spec 021-2 / FR-004)", () => {
  it("preserves client-supplied session ID", async () => {
    const manager = new ServerSessionManager({ backend: new MemoryPersistenceBackend() });
    const session = await manager.createSession("test-api-key", {
      id: "client-session-123",
      provider: "openai",
      model: "gpt-4o",
    });

    expect(session.id).toBe("client-session-123");
    expect(session.provider).toBe("openai");
    expect(session.model).toBe("gpt-4o");
  });

  it("mints random UUID when id is omitted", async () => {
    const manager = new ServerSessionManager({ backend: new MemoryPersistenceBackend() });
    const session = await manager.createSession("test-api-key");
    expect(session.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it("rejects client IDs with invalid charset (path traversal / spaces)", async () => {
    const manager = new ServerSessionManager({ backend: new MemoryPersistenceBackend() });
    await expect(
      manager.createSession("test-api-key", { id: "../traversal" }),
    ).rejects.toThrow(/invalid.*id|charset/i);

    await expect(
      manager.createSession("test-api-key", { id: "has spaces" }),
    ).rejects.toThrow(/invalid.*id|charset/i);
  });

  it("refuses collision when session id already exists in memory", async () => {
    const manager = new ServerSessionManager({ backend: new MemoryPersistenceBackend() });
    await manager.createSession("test-api-key", { id: "dup-id" });

    await expect(
      manager.createSession("test-api-key", { id: "dup-id" }),
    ).rejects.toThrow(/already exists|collision/i);
  });

  it("refuses collision when session id exists in backend store", async () => {
    const backend = new MemoryPersistenceBackend();
    await backend.save("backend-preexisting", {
      id: "backend-preexisting",
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const manager = new ServerSessionManager({ backend });
    await expect(
      manager.createSession("test-api-key", { id: "backend-preexisting" }),
    ).rejects.toThrow(/already exists|collision/i);
  });

  it("addMessage throws loudly on unknown session ID", () => {
    const manager = new ServerSessionManager({ backend: new MemoryPersistenceBackend() });
    const msg: Message = {
      id: "m1",
      role: "user",
      content: "Hello",
      timestamp: Date.now(),
    };

    expect(() => {
      manager.addMessage("non-existent-session-id", msg);
    }).toThrow(/not found/i);
  });
});
