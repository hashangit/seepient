/**
 * J2 Adversarial Journey — VULN-2 / VULN-4 / VULN-13: Identity validation at the source.
 *
 * Verifies that principalId is strictly validated against PRINCIPAL_ID_RE (/^[a-zA-Z0-9_-]{1,128}$/)
 * and sentinels are rejected case-insensitively directly at the Domain factory (buildActionLifecycle),
 * preventing path traversal in local reference stores and sentinel identity collapse.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildActionLifecycle } from "../../action-lifecycle-factory.js";
import { LocalPolicyStore } from "../../policy-store.js";
import { PersistedCapabilityLedger } from "../../persisted-capability-ledger.js";
import { LocalAuditStore } from "../../audit-recorder.js";
import { createSecurityGuard } from "./_guard.js";
import type { PolicyStore } from "../../../../foundations/contracts/execution-brokers.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("J2 Identity Validation Battery (VULN-2 / VULN-4 / VULN-13)", () => {
  let tempDir: string;
  let guard = createSecurityGuard("VULN-2");

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "seepient-j2-identity-"));
    guard = createSecurityGuard("VULN-2");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("Domain factory rejects invalid characters, path traversals, and sentinels", async () => {
    const invalidIds = [
      "../traversal",
      "../../etc/passwd",
      "tenant/slash",
      "tenant\\backslash",
      "tenant space",
      "tenant@domain",
      "default",
      "DEFAULT",
      "sdk-user",
      "SDK-USER",
      "anonymous",
      "ANONYMOUS",
      "",
      " ",
    ];

    const policyStore = new LocalPolicyStore({ root: join(tempDir, "policy") });
    const capabilityLedger = new PersistedCapabilityLedger({ root: join(tempDir, "caps") });
    const auditStore = new LocalAuditStore({ root: join(tempDir, "audit") });

    let leakedCalls = 0;
    const instrumentedPolicyStore: PolicyStore = {
      isIsolated: true,
      read: async (ws: string, opts?: any) => {
        leakedCalls++;
        return policyStore.read(ws, opts);
      },
      compareAndSet: policyStore.compareAndSet.bind(policyStore),
    };

    for (const invalidId of invalidIds) {
      await expect(async () => {
        await buildActionLifecycle({
          runId: "test-run-1",
          approvalBroker: { requestApproval: async () => ({ decision: "deny" }) } as any,
          workspaceRoot: tempDir,
          tenancyMode: "multi",
          principalId: invalidId,
          policyStore: instrumentedPolicyStore,
          capabilityLedger,
          auditStore,
          interaction: { mode: "none" },
          executionBoundary: { capabilities: [] } as any,
        });
      }).rejects.toThrow(/(INVALID_PRINCIPAL_ID|PRINCIPAL_REQUIRED|invalid principal|sentinel)/i);
    }

    expect(leakedCalls).toBe(0);
  });

  it("Domain factory accepts valid slug characters", async () => {
    const validIds = [
      "tenant-1",
      "TENANT-2",
      "tenant_3",
      "User-123_abc",
      "a",
      "a".repeat(128),
    ];

    const policyStore = new LocalPolicyStore({ root: join(tempDir, "policy") });
    const capabilityLedger = new PersistedCapabilityLedger({ root: join(tempDir, "caps") });
    const auditStore = new LocalAuditStore({ root: join(tempDir, "audit") });

    const instrumentedPolicyStore: PolicyStore = {
      isIsolated: true,
      read: async (ws: string, opts?: any) => {
        guard.recordHit(`policyStore.read:${opts?.principalId}`);
        return policyStore.read(ws, opts);
      },
      compareAndSet: policyStore.compareAndSet.bind(policyStore),
    };

    for (const validId of validIds) {
      const lifecycle = await buildActionLifecycle({
        runId: "test-run-2",
        approvalBroker: { requestApproval: async () => ({ decision: "deny" }) } as any,
        workspaceRoot: tempDir,
        tenancyMode: "multi",
        principalId: validId,
        policyStore: instrumentedPolicyStore,
        capabilityLedger,
        auditStore,
        interaction: { mode: "none" },
        executionBoundary: { capabilities: [] } as any,
      });
      expect(lifecycle).toBeDefined();
    }

    guard.assertGuardedPathExecuted(validIds.length);
  });
});
