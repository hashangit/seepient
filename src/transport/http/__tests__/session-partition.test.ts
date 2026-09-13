/**
 * J3 Adversarial Journey — VULN-3: Session squatting DoS and existence oracle.
 *
 * Verifies that ServerSessionManager partitions sessions by composite key `${apiKeyHash}:${sessionId}`,
 * allowing two different API keys to create sessions with the same explicit session ID without
 * collision, squatting DoS, or leaking existence.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ServerSessionManager, hashKey } from "../session-store.js";
import { MemoryPersistenceBackend } from "../../../domain/sessions/session-store.js";
import type { PersistenceBackend } from "../../../foundations/types.js";
import { createSecurityGuard } from "../../../domain/permissions/__tests__/composition-closure/_guard.js";

describe("J3 Session Partition Journey (VULN-3)", () => {
  let manager: ServerSessionManager;
  let guard = createSecurityGuard("VULN-3");

  beforeEach(() => {
    const rawBackend = new MemoryPersistenceBackend();
    const instrumentedBackend: PersistenceBackend = {
      ...rawBackend,
      save: async (id, data) => {
        guard.recordHit(`backend.save:${data.metadata?.apiKeyHash}`);
        return rawBackend.save(id, data);
      },
      load: rawBackend.load.bind(rawBackend),
      delete: rawBackend.delete.bind(rawBackend),
      list: rawBackend.list.bind(rawBackend),
    };
    manager = new ServerSessionManager({
      backend: instrumentedBackend,
    });
    guard = createSecurityGuard("VULN-3");
  });

  afterEach(() => {
    manager.stopCleanup();
  });

  it("two distinct API keys can concurrently create sessions with identical explicit ID in isolated partitions", async () => {
    const keyA = "seepient-api-key-tenant-alpha-111";
    const keyB = "seepient-api-key-tenant-beta-222";
    const hashA = hashKey(keyA);
    const hashB = hashKey(keyB);

    const sharedSessionId = "shared-custom-session-id-42";

    // Tenant A creates session with sharedSessionId
    const sessionA = await manager.createSession(keyA, {
      id: sharedSessionId,
      provider: "mock-provider",
      model: "mock-model",
    });
    expect(sessionA.id).toBe(sharedSessionId);

    // On baseline (0b7fe4e): Flat map keyed only by sharedSessionId causes Tenant B's
    // creation to fail with SESSION_ALREADY_EXISTS (VULN-3 session squatting / existence oracle).
    // In fixed implementation: Keyed by apiKeyHash:sessionId, both succeed.
    const sessionB = await manager.createSession(keyB, {
      id: sharedSessionId,
      provider: "mock-provider",
      model: "mock-model",
    });
    expect(sessionB.id).toBe(sharedSessionId);

    // Verify retrieval isolation:
    const fetchedA = await manager.getSession(sharedSessionId, hashA);
    const fetchedB = await manager.getSession(sharedSessionId, hashB);

    expect(fetchedA).not.toBeNull();
    expect(fetchedB).not.toBeNull();
    expect(fetchedA?.id).toBe(sharedSessionId);
    expect(fetchedB?.id).toBe(sharedSessionId);

    guard.assertGuardedPathExecuted(2);
  });
});
