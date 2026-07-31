import { describe, it, expect } from "vitest";
import {
  MemoryPersistenceBackend,
  createPersistenceBackend,
  registerBackend,
} from "../session-store.js";
import type { SessionData } from "../../../foundations/types.js";

describe("MemoryPersistenceBackend", () => {
  it("saves and loads a session", async () => {
    const store = new MemoryPersistenceBackend();
    const data: SessionData = {
      id: "sess-1",
      messages: [
        { id: "m1", role: "user", content: "hi", timestamp: 1000 },
      ],
      createdAt: 1000,
      updatedAt: 1000,
    };
    await store.save("sess-1", data);
    const loaded = await store.load("sess-1");
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe("sess-1");
    expect(loaded!.messages).toHaveLength(1);
    expect(loaded!.messages[0].content).toBe("hi");
  });

  it("returns null for non-existent session", async () => {
    const store = new MemoryPersistenceBackend();
    const loaded = await store.load("nope");
    expect(loaded).toBeNull();
  });

  it("deletes a session", async () => {
    const store = new MemoryPersistenceBackend();
    await store.save("sess-del", {
      id: "sess-del",
      messages: [],
      createdAt: 1000,
      updatedAt: 1000,
    });
    await store.delete("sess-del");
    const loaded = await store.load("sess-del");
    expect(loaded).toBeNull();
  });

  it("list returns all session IDs", async () => {
    const store = new MemoryPersistenceBackend();
    await store.save("a", { id: "a", messages: [], createdAt: 1, updatedAt: 1 });
    await store.save("b", { id: "b", messages: [], createdAt: 2, updatedAt: 2 });
    const ids = await store.list();
    expect(ids.sort()).toEqual(["a", "b"]);
  });

  it("preserves createdAt on overwrite", async () => {
    const store = new MemoryPersistenceBackend();
    // First save — createdAt is set by the backend to Date.now()
    await store.save("sess-x", {
      id: "sess-x",
      messages: [],
      createdAt: 1, // ignored by MemoryPersistenceBackend on first save
      updatedAt: 1,
    });
    const first = await store.load("sess-x");
    const firstCreatedAt = first!.createdAt;
    expect(firstCreatedAt).toBeGreaterThan(0);

    // Second save — createdAt should be preserved from first save
    await store.save("sess-x", {
      id: "sess-x",
      messages: [{ id: "m1", role: "user", content: "hi", timestamp: 2000 }],
      createdAt: 9999, // should be ignored — existing createdAt preserved
      updatedAt: 2000,
    });
    const loaded = await store.load("sess-x");
    expect(loaded!.createdAt).toBe(firstCreatedAt);
    // updatedAt may equal createdAt if saves happen in same millisecond,
    // but messages must reflect the overwrite
    expect(loaded!.messages).toHaveLength(1);
  });

  it("rejects invalid session IDs", async () => {
    const store = new MemoryPersistenceBackend();
    await expect(
      store.save("bad!id", { id: "bad!id", messages: [], createdAt: 1, updatedAt: 1 }),
    ).rejects.toThrow("Invalid session ID");
  });
});

describe("createPersistenceBackend", () => {
  it("creates a memory backend", () => {
    const backend = createPersistenceBackend({ type: "memory" });
    expect(backend).toBeInstanceOf(MemoryPersistenceBackend);
  });

  it("throws on unknown type", () => {
    expect(() => createPersistenceBackend({ type: "redis" })).toThrow(
      'Unknown persistence backend type "redis"',
    );
  });
});

describe("registerBackend", () => {
  it("registers and uses a custom backend", () => {
    registerBackend("test-custom", () => new MemoryPersistenceBackend());
    const backend = createPersistenceBackend({ type: "test-custom" });
    expect(backend).toBeInstanceOf(MemoryPersistenceBackend);
  });
});
