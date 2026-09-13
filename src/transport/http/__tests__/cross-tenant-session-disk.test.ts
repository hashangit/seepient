import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { ServerSessionManager, hashKey } from "../session-store.js";
import { FilePersistenceBackend } from "../../../domain/sessions/session-store.js";

describe("Cross-tenant session disk isolation and turn concurrency", () => {
  let tempSessionDir: string;
  let backend: FilePersistenceBackend;
  let manager: ServerSessionManager;

  const keyA = "seepient-api-key-tenant-alpha-111";
  const keyB = "seepient-api-key-tenant-beta-222";
  const hashA = hashKey(keyA);
  const hashB = hashKey(keyB);
  const sharedSessionId = "shared-session-collision-99";

  beforeEach(async () => {
    tempSessionDir = path.join(
      os.tmpdir(),
      `seepient-disk-iso-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    backend = new FilePersistenceBackend(tempSessionDir);
    manager = new ServerSessionManager({ backend });
  });

  afterEach(async () => {
    manager.stopCleanup();
    try {
      await fs.rm(tempSessionDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("creates separate disk files for identical session IDs across tenants without disk overwrite", async () => {
    // 1. Tenant A creates session with shared ID
    const sessionA = await manager.createSession(keyA, {
      id: sharedSessionId,
      provider: "openai",
      model: "gpt-4o",
    });
    expect(sessionA.id).toBe(sharedSessionId);

    manager.addMessage(sharedSessionId, {
      id: "msg-a-1",
      role: "user",
      content: "Hello from tenant A",
      timestamp: Date.now(),
    }, hashA);

    // 2. Tenant B creates session with identical shared ID
    const sessionB = await manager.createSession(keyB, {
      id: sharedSessionId,
      provider: "anthropic",
      model: "claude-3-5-sonnet",
    });
    expect(sessionB.id).toBe(sharedSessionId);

    manager.addMessage(sharedSessionId, {
      id: "msg-b-1",
      role: "user",
      content: "Hello from tenant B",
      timestamp: Date.now(),
    }, hashB);

    // Wait briefly for async persistence
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Verify disk files: must be prefixed by apiKeyHash
    const files = await fs.readdir(tempSessionDir);
    const jsonFiles = files.filter((f) => f.endsWith(".json"));

    // Expect two distinct files on disk: ${hashA}:${sharedSessionId}.json and ${hashB}:${sharedSessionId}.json
    expect(jsonFiles.length).toBe(2);
    expect(jsonFiles).toContain(`${hashA}:${sharedSessionId}.json`);
    expect(jsonFiles).toContain(`${hashB}:${sharedSessionId}.json`);

    // Verify file contents: Tenant A's file has Tenant A's message, Tenant B's file has Tenant B's message
    const rawA = await fs.readFile(path.join(tempSessionDir, `${hashA}:${sharedSessionId}.json`), "utf-8");
    const parsedA = JSON.parse(rawA);
    expect(parsedA.messages.some((m: any) => m.content === "Hello from tenant A")).toBe(true);
    expect(parsedA.messages.some((m: any) => m.content === "Hello from tenant B")).toBe(false);

    const rawB = await fs.readFile(path.join(tempSessionDir, `${hashB}:${sharedSessionId}.json`), "utf-8");
    const parsedB = JSON.parse(rawB);
    expect(parsedB.messages.some((m: any) => m.content === "Hello from tenant B")).toBe(true);
    expect(parsedB.messages.some((m: any) => m.content === "Hello from tenant A")).toBe(false);
  });

  it("concurrent turns on identical session IDs do not block across tenants", async () => {
    await manager.createSession(keyA, { id: sharedSessionId });
    await manager.createSession(keyB, { id: sharedSessionId });

    // Tenant A starts turn
    const turnA = manager.acquireTurn(sharedSessionId, hashA);
    expect(turnA).toBe(true);

    // Tenant B must ALSO be able to start turn on their own session!
    const turnB = manager.acquireTurn(sharedSessionId, hashB);
    expect(turnB).toBe(true);

    // Second turn attempt for Tenant A should fail (A is busy)
    expect(manager.acquireTurn(sharedSessionId, hashA)).toBe(false);

    // Release Tenant A's turn
    manager.releaseTurn(sharedSessionId, hashA);
    expect(manager.isTurnInFlight(sharedSessionId, hashA)).toBe(false);
    // Tenant B is still in flight
    expect(manager.isTurnInFlight(sharedSessionId, hashB)).toBe(true);

    // Release Tenant B
    manager.releaseTurn(sharedSessionId, hashB);
    expect(manager.isTurnInFlight(sharedSessionId, hashB)).toBe(false);
  });

  it("deleting a session by Tenant B does not delete Tenant A's in-memory session or disk file", async () => {
    await manager.createSession(keyA, { id: sharedSessionId });
    manager.addMessage(sharedSessionId, {
      id: "msg-a",
      role: "user",
      content: "Tenant A secret message",
      timestamp: Date.now(),
    }, hashA);

    await manager.createSession(keyB, { id: sharedSessionId });
    manager.addMessage(sharedSessionId, {
      id: "msg-b",
      role: "user",
      content: "Tenant B disposable message",
      timestamp: Date.now(),
    }, hashB);

    await new Promise((resolve) => setTimeout(resolve, 50));

    // Tenant B deletes their session
    manager.deleteSession(sharedSessionId, hashB);
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Tenant B's session is deleted
    const sessionB = await manager.getSession(sharedSessionId, hashB);
    expect(sessionB).toBeNull();

    // Tenant A's session MUST still exist in memory AND on disk!
    const sessionA = await manager.getSession(sharedSessionId, hashA);
    expect(sessionA).not.toBeNull();
    expect(sessionA?.messages.some((m) => m.content === "Tenant A secret message")).toBe(true);

    // Verify disk: Tenant A's file still exists
    const fileExistsA = await fs
      .access(path.join(tempSessionDir, `${hashA}:${sharedSessionId}.json`))
      .then(() => true)
      .catch(() => false);
    expect(fileExistsA).toBe(true);

    // Verify disk: Tenant B's file is gone
    const fileExistsB = await fs
      .access(path.join(tempSessionDir, `${hashB}:${sharedSessionId}.json`))
      .then(() => true)
      .catch(() => false);
    expect(fileExistsB).toBe(false);
  });
});
