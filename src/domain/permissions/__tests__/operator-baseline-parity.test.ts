import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildActionLifecycle } from "../action-lifecycle-factory.js";
import { LocalPolicyStore } from "../policy-store.js";
import type { Capability, CapabilitySet, ApprovalBroker } from "../../../foundations/contracts/permission-policy.js";

const NOOP_BROKER: ApprovalBroker = {
  mode: "inline",
  request: async (req) => ({
    approved: false,
    requestId: req.requestId,
    actionDigest: req.actionDigest,
    actorId: "test-broker",
    reason: "cancelled",
    decidedAt: Date.now(),
  }),
};
const FAKE_BOUNDARY: any = {
  capabilities: {
    backend: "uncontained",
    capabilityKinds: ["read-root", "write-root", "network-destination", "secret-ref"],
    exactCommit: false,
    hostFilteredEgress: false,
    environmentIsolation: false,
    supportedOperationKinds: ["read", "write", "network"],
  },
  async execute() {
    return {
      state: "executed" as const,
      evidence: {
        backend: "uncontained" as const,
        actionDigest: "d",
        executorId: "e",
        operationKind: "read" as const,
      },
    };
  },
};

describe("FR-022: Operator Baseline Composition & Single-Mode Byte Parity (T025)", () => {
  let tempDir: string;
  const originalTavilyKey = process.env.TAVILY_API_KEY;

  beforeEach(() => {
    tempDir = fs.realpathSync(mkdtempSync(join(tmpdir(), "seepient-op-baseline-")));
    process.env.TAVILY_API_KEY = "tvly-test-secret-key-12345";
  });

  afterEach(() => {
    if (originalTavilyKey !== undefined) {
      process.env.TAVILY_API_KEY = originalTavilyKey;
    } else {
      delete process.env.TAVILY_API_KEY;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("single mode includes config-derived grants in active capabilities (017 promise intact)", async () => {
    const policyStore = new LocalPolicyStore({ root: join(tempDir, "policies") });

    const lifecycleSingle = await buildActionLifecycle({
      principalId: "single-user",
      runId: "run-single",
      workspaceRoot: tempDir,
      approvalBroker: NOOP_BROKER,
      executionBoundary: FAKE_BOUNDARY,
      policyStore,
      auditRoot: join(tempDir, "audit"),
      tenancyMode: "single",
    });

    const activeCaps = lifecycleSingle.policyContext.activeCapabilities.capabilities;

    // Verify Tavily config grants are present in single mode
    const hasTavilyNetwork = activeCaps.some(
      (c) => c.kind === "network-destination" && c.host === "api.tavily.com",
    );
    const hasTavilySecret = activeCaps.some(
      (c) => c.kind === "secret-ref" && c.ref === "tavilyApiKey",
    );

    expect(hasTavilyNetwork).toBe(true);
    expect(hasTavilySecret).toBe(true);
  });

  it("multi mode tenant baseline does NOT contain config-derived grants", async () => {
    const policyStore = new LocalPolicyStore({ root: join(tempDir, "policies") });

    const lifecycleMulti = await buildActionLifecycle({
      principalId: "tenant-isolated",
      runId: "run-multi",
      workspaceRoot: tempDir,
      approvalBroker: NOOP_BROKER,
      executionBoundary: FAKE_BOUNDARY,
      policyStore,
      auditRoot: join(tempDir, "audit"),
      tenancyMode: "multi",
    });

    const activeCaps = lifecycleMulti.policyContext.activeCapabilities.capabilities;

    // Verify Tavily config grants are NOT leaked to multi-tenant baseline
    const hasTavilyNetwork = activeCaps.some(
      (c) => c.kind === "network-destination" && c.host === "api.tavily.com",
    );
    const hasTavilySecret = activeCaps.some(
      (c) => c.kind === "secret-ref" && c.ref === "tavilyApiKey",
    );

    expect(hasTavilyNetwork).toBe(false);
    expect(hasTavilySecret).toBe(false);
  });

  it("multi mode honors explicit operatorBaseline without leaking ambient config", async () => {
    const policyStore = new LocalPolicyStore({ root: join(tempDir, "policies") });
    const explicitCap: Capability = { kind: "network-destination", scheme: "https", host: "tenant-service.internal" };
    const operatorBaseline: CapabilitySet = {
      version: 1,
      capabilities: [explicitCap],
    };

    const lifecycleMulti = await buildActionLifecycle({
      principalId: "tenant-explicit",
      runId: "run-multi-explicit",
      workspaceRoot: tempDir,
      approvalBroker: NOOP_BROKER,
      executionBoundary: FAKE_BOUNDARY,
      policyStore,
      auditRoot: join(tempDir, "audit"),
      tenancyMode: "multi",
      operatorBaseline,
    });

    const activeCaps = lifecycleMulti.policyContext.activeCapabilities.capabilities;

    // Explicit cap is present
    expect(activeCaps.some((c) => c.kind === "network-destination" && c.host === "tenant-service.internal")).toBe(true);
    // Ambient Tavily config is still absent
    expect(activeCaps.some((c) => c.kind === "network-destination" && c.host === "api.tavily.com")).toBe(false);
  });

  it("single mode active capabilities match byte-parity with baseline fresh capabilities + config grants", async () => {
    const policyStore = new LocalPolicyStore({ root: join(tempDir, "policies") });

    const lifecycle = await buildActionLifecycle({
      principalId: "sdk-user",
      runId: "run-parity",
      workspaceRoot: tempDir,
      approvalBroker: NOOP_BROKER,
      executionBoundary: FAKE_BOUNDARY,
      policyStore,
      auditRoot: join(tempDir, "audit"),
      tenancyMode: "single",
    });

    const active = lifecycle.policyContext.activeCapabilities.capabilities;

    // Canonical single-mode fresh set: read-root, model-egress, Tavily network, Tavily secret-ref
    expect(active).toContainEqual({ kind: "read-root", root: tempDir });
    expect(active).toContainEqual({ kind: "model-egress", providerClass: "*", dataClasses: ["normal", "sensitive"] });
    expect(active).toContainEqual({ kind: "network-destination", scheme: "https", host: "api.tavily.com" });
    expect(active).toContainEqual({ kind: "secret-ref", ref: "tavilyApiKey" });
  });
});
