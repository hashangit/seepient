import { describe, it, expect } from "vitest";
import { ServerSessionManager, hashKey } from "../session-store.js";
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

  it("exempts in-flight turn sessions from inactivity timeout cleanup (W008)", async () => {
    const manager = new ServerSessionManager({
      backend: new MemoryPersistenceBackend(),
      inactivityTimeout: 1000, // 1 second
      sessionTTL: 24 * 60 * 60 * 1000, // 24 hours
    });

    const session1 = await manager.createSession("test-key", { id: "in-flight-session" });
    const session2 = await manager.createSession("test-key", { id: "idle-session" });

    // Mark session1 as in-flight
    expect(manager.acquireTurn(session1.id)).toBe(true);

    // Simulate 30-min inactivity passed for both sessions
    const oldTime = Date.now() - 30 * 60 * 1000;
    (manager as any).sessions.get(session1.id)!.lastActivityAt = oldTime;
    (manager as any).sessions.get(session2.id)!.lastActivityAt = oldTime;

    // Run cleanup
    manager.cleanup();

    // session1 is in-flight, so it MUST survive cleanup!
    expect((manager as any).sessions.has(session1.id)).toBe(true);

    // session2 was idle, so it MUST be reaped!
    expect((manager as any).sessions.has(session2.id)).toBe(false);

    // But absolute TTL ceiling (24h) still reaps even in-flight sessions
    (manager as any).sessions.get(session1.id)!.createdAt = Date.now() - 25 * 60 * 60 * 1000;
    manager.cleanup();
    expect((manager as any).sessions.has(session1.id)).toBe(false);
  });

  it("atomically guards concurrent createSession with same ID (W010)", async () => {
    // A slow backend that introduces latency in load
    const backend = new MemoryPersistenceBackend();
    const origLoad = backend.load.bind(backend);
    backend.load = async (id: string) => {
      await new Promise((r) => setTimeout(r, 20));
      return origLoad(id);
    };

    const manager = new ServerSessionManager({ backend });

    // Launch two createSession calls concurrently with the same client id
    const results = await Promise.allSettled([
      manager.createSession("test-key", { id: "concurrent-client-id" }),
      manager.createSession("test-key", { id: "concurrent-client-id" }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);

    const error = (rejected[0] as PromiseRejectedResult).reason;
    expect(error.message).toMatch(/SESSION_ALREADY_EXISTS/);
  });

  it("hashes raw key and 64-hex key passed positionally, only accepting precomputed hash via options (W013)", async () => {
    const backend = new MemoryPersistenceBackend();
    const manager = new ServerSessionManager({ backend });

    // 1. Raw key with 'hash' substring should be hashed, not stored raw
    const keyWithHash = "my-test-api-key-hash-token";
    const s1 = await manager.createSession(keyWithHash, { id: "sess-1" });
    const stored1 = (manager as any).sessions.get(s1.id);
    expect(stored1.apiKeyHash).not.toBe(keyWithHash);
    expect(stored1.apiKeyHash).toMatch(/^[0-9a-f]{64}$/);

    // 2. 64-hex shaped key passed positionally must also be hashed
    const hex64Key = "a".repeat(64);
    const s2 = await manager.createSession(hex64Key, { id: "sess-2" });
    const stored2 = (manager as any).sessions.get(s2.id);
    expect(stored2.apiKeyHash).not.toBe(hex64Key);
    expect(stored2.apiKeyHash).toMatch(/^[0-9a-f]{64}$/);

    // 3. Precomputed hash is ONLY accepted via explicit options.apiKeyHash
    const precomputed = "b".repeat(64);
    const s3 = await manager.createSession("any-key", { id: "sess-3", apiKeyHash: precomputed });
    const stored3 = (manager as any).sessions.get(s3.id);
    expect(stored3.apiKeyHash).toBe(precomputed);

    // 4. hashKey helper itself always hashes 64-hex input without fast-path
    expect(hashKey(hex64Key)).not.toBe(hex64Key);
  });

  it("fails closed on hash-less backend sessions with teaching error (W014)", async () => {
    const backend = new MemoryPersistenceBackend();
    await backend.save("unowned-sdk-session", {
      id: "unowned-sdk-session",
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      // No metadata or apiKeyHash
    });

    const manager = new ServerSessionManager({ backend });
    await expect(
      manager.getSession("unowned-sdk-session", "test-key-hash"),
    ).rejects.toThrow(/session has no server owner; SDK-persisted sessions are not server-resumable/i);
  });

  it("fails closed on legacy 16-hex hashed sessions with teaching error (W014)", async () => {
    const backend = new MemoryPersistenceBackend();
    await backend.save("legacy-16-session", {
      id: "legacy-16-session",
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata: {
        apiKeyHash: "0123456789abcdef", // 16-hex legacy hash
      },
    });

    const manager = new ServerSessionManager({ backend });
    await expect(
      manager.getSession("legacy-16-session", "0123456789abcdef"),
    ).rejects.toThrow(/session has no server owner; SDK-persisted sessions are not server-resumable/i);
  });
});
