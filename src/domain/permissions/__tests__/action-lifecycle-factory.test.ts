/**
 * T042: FRESH-INSTALL-LOSS gate (FR-030)
 *
 * Verifies that in single mode, if a workspace policy exists at version >= 1
 * containing only caps stamped for another principal (e.g. "cli-user"),
 * building an action lifecycle for a fresh principal (e.g. "sdk-user")
 * still seeds activeCapabilities with fresh install defaults (`read-root` + default `model-egress`).
 */
import { describe, it, expect } from "vitest";
import { buildActionLifecycle } from "../action-lifecycle-factory.js";
import { InMemoryPolicyStore, InMemoryAuditStore, InMemoryCapabilityLedger } from "../in-memory-stores.js";

describe("T042: FRESH-INSTALL-LOSS Gate (FR-030)", () => {
  it("single mode sdk-user in workspace with only cli-user grants retains fresh-install baselines", async () => {
    const policyStore = new InMemoryPolicyStore();
    const auditStore = new InMemoryAuditStore();
    const capabilityLedger = new InMemoryCapabilityLedger();
    const workspaceId = "test-workspace-cli-only";
    const workspaceRoot = "/tmp/test-workspace-cli-only";

    // Store a policy at version 1 containing ONLY "cli-user"-stamped caps
    await policyStore.compareAndSet(
      workspaceId,
      0,
      {
        version: 1,
        capabilities: [
          { kind: "read-root", root: workspaceRoot, principalId: "cli-user" },
          { kind: "write-root", root: workspaceRoot, principalId: "cli-user" },
        ],
      },
      { kind: "operator" } as any,
    );

    // Build action lifecycle for "sdk-user" in single mode
    const wired = await buildActionLifecycle({
      runId: "run-factory-test",
      workspaceRoot,
      principalId: "sdk-user",
      tenancyMode: "single",
      policyStore,
      auditStore,
      capabilityLedger,
      interaction: { mode: "inline", deadlineMs: 30_000 },
      approvalBroker: { mode: "inline" } as any,
      executionBoundary: {
        capabilities: {
          backend: "local-native",
          capabilityKinds: ["read-root", "write-root", "model-egress"],
          exactCommit: true,
          hostFilteredEgress: true,
          environmentIsolation: true,
          supportedOperationKinds: ["read-file", "commit-files"],
        },
      } as any,
    });

    const activeCaps = wired.activeCapabilities.capabilities;

    // Assert that activeCapabilities still include read-root and model-egress
    const hasReadRoot = activeCaps.some((c) => c.kind === "read-root");
    const hasModelEgress = activeCaps.some((c) => c.kind === "model-egress");

    expect(hasReadRoot).toBe(true);
    expect(hasModelEgress).toBe(true);
  });
});
