/**
 * Tests for the shared save-orchestration helper `persistSession`.
 *
 * This helper is the single source of truth for the persist step shared by the
 * SDK, CLI, and Server adapters. The contract under test: it delegates to the
 * backend's save(), preserving createdAt on overwrite, and only writes the
 * optional provider/model/metadata fields the caller supplies.
 */
import { describe, it, expect } from "vitest";
import { MemoryPersistenceBackend, persistSession } from "../session-store.js";
import type { Message } from "../../../foundations/types.js";

function msg(role: Message["role"], content: string, timestamp: number): Message {
  return { id: `${role}-${timestamp}`, role, content, timestamp };
}

describe("persistSession", () => {
  it("saves a session with messages and a backend-assigned createdAt", async () => {
    const backend = new MemoryPersistenceBackend();
    const before = Date.now();
    const messages = [msg("system", "sys", 1000), msg("user", "hi", 2000)];

    await persistSession(backend, "sess-1", messages);

    const loaded = await backend.load("sess-1");
    expect(loaded).not.toBeNull();
    expect(loaded!.messages).toEqual(messages);
    // createdAt is assigned by the backend (≈ now), not derived from messages.
    expect(loaded!.createdAt).toBeGreaterThanOrEqual(before);
    expect(loaded!.provider).toBeUndefined();
    expect(loaded!.model).toBeUndefined();
  });

  it("writes provider and model when supplied", async () => {
    const backend = new MemoryPersistenceBackend();

    await persistSession(backend, "sess-1", [msg("user", "hi", 1000)], {
      provider: "anthropic",
      model: "claude-3.5",
    });

    const loaded = await backend.load("sess-1");
    expect(loaded!.provider).toBe("anthropic");
    expect(loaded!.model).toBe("claude-3.5");
  });

  it("preserves createdAt on overwrite (backend merge contract)", async () => {
    const backend = new MemoryPersistenceBackend();

    await persistSession(backend, "sess-1", [msg("user", "first", 5000)]);
    const first = await backend.load("sess-1");
    const originalCreatedAt = first!.createdAt;

    // Second save with different messages — createdAt must be unchanged.
    await persistSession(backend, "sess-1", [msg("user", "second", 9999)]);

    const loaded = await backend.load("sess-1");
    expect(loaded!.createdAt).toBe(originalCreatedAt);
    expect(loaded!.messages[0].content).toBe("second");
  });

  it("does not clobber existing provider/model when caller omits them", async () => {
    const backend = new MemoryPersistenceBackend();

    await persistSession(backend, "sess-1", [msg("user", "hi", 1000)], {
      provider: "openai",
      model: "gpt-4o",
    });
    // CLI path may save without opts on some turns — existing values survive.
    await persistSession(backend, "sess-1", [msg("user", "hi again", 2000)]);

    const loaded = await backend.load("sess-1");
    expect(loaded!.provider).toBe("openai");
    expect(loaded!.model).toBe("gpt-4o");
  });
});
