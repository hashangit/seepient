import { describe, it, expect } from "vitest";
import { createSeepient } from "../index.js";
import { InMemoryCapabilityLedger, InMemoryAuditStore, InMemoryPolicyStore } from "../../../domain/permissions/in-memory-stores.js";
import { createFakeRuntime } from "./helpers/fake-stores.js";

describe("T069: FR-041 Revocation Surface (agent.revokeRun / agent.revokeSession)", () => {
  it("agent.revokeRun and agent.revokeSession revoke capabilities on the ledger", async () => {
    const ledger = new InMemoryCapabilityLedger();
    const auditStore = new InMemoryAuditStore();
    const policyStore = new InMemoryPolicyStore();
    const runtime = createFakeRuntime({ responses: [{ text: "ok" }] });

    const agent = await createSeepient({
      principalId: "tenant-rev-1",
      cwd: "/tmp/tenant-rev-1",
      runtime,
      auditStore,
      policyStore,
      capabilityLedger: ledger,
      tenancy: "multi",
      stateless: true,
    });

    expect(typeof agent.revokeRun).toBe("function");
    expect(typeof agent.revokeSession).toBe("function");

    // Initially not revoked
    expect(ledger.isRunRevoked("run-123", { principalId: "tenant-rev-1" })).toBe(false);
    expect(ledger.isSessionRevoked("sess-456", { principalId: "tenant-rev-1" })).toBe(false);

    // Call agent.revokeRun
    await agent.revokeRun("run-123");
    expect(ledger.isRunRevoked("run-123", { principalId: "tenant-rev-1" })).toBe(true);

    // Call agent.revokeSession
    await agent.revokeSession("sess-456");
    expect(ledger.isSessionRevoked("sess-456", { principalId: "tenant-rev-1" })).toBe(true);

    await agent.close();
  });
});
