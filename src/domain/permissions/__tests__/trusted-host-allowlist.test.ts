/**
 * Trusted-host operator allowlist tests (spec 019 FR-006, T024/T025,
 * QS-0.8).
 *
 * The blanket trusted-host ceiling exemption is replaced by allowlist
 * membership: a `trusted-host` capability is within the deployment ceiling
 * only when its registrationId/toolName is a member of
 * `permissions.trustedHostAllowlist` (default `["use_skill"]`). Denial
 * messages name the setting.
 */
import { describe, it, expect } from "vitest";
import { PolicyEngine } from "../policy-engine.js";
import type {
  PolicyContext,
  Capability,
  CapabilitySet,
} from "../../../foundations/contracts/permission-policy.js";
import type { PreparedToolAction } from "../../../foundations/contracts/prepared-action.js";
import type {
  ExecutionBackendCapabilities,
} from "../../../foundations/contracts/execution-boundary.js";

const BACKEND: ExecutionBackendCapabilities = {
  backend: "local-native",
  capabilityKinds: ["trusted-host", "commit-file", "read-file", "read-root", "process", "model-egress"],
  exactCommit: true,
  jsFsFallbackOptIn: false,
  hostFilteredEgress: true,
  environmentIsolation: true,
  supportedOperationKinds: ["none", "read-file", "commit-files", "process", "broker", "trusted-host"],
};

function set(...caps: Capability[]): CapabilitySet {
  return { version: 1, capabilities: caps };
}

function context(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    deploymentCeiling: set({ kind: "trusted-host", registrationId: "use_skill" }),
    principalPolicy: set(),
    runtimeBaseline: set(),
    activeCapabilities: set(),
    immutableDenies: [],
    approvalMode: "manual",
    interaction: { mode: "inline", deadlineMs: 30_000 },
    backendCapabilities: BACKEND,
    ...overrides,
  };
}

function hostAction(registrationId: string): PreparedToolAction {
  return {
    version: 1,
    actionId: "a1",
    runId: "r1",
    toolCallId: "c1",
    toolName: registrationId,
    principalId: "user",
    argsDigest: "x",
    actionDigest: "d-" + registrationId,
    risk: "destructive",
    effects: [{ kind: "host-callback", toolName: registrationId }],
    display: {
      title: registrationId,
      summary: `Execute host callback ${registrationId}`,
      canonicalTargets: [],
      effects: ["host-callback"],
    },
    operation: {
      kind: "trusted-host",
      registrationId,
      toolName: registrationId,
      args: {},
    },
  };
}

describe("trusted-host operator allowlist (spec 019 FR-006, QS-0.8)", () => {
  it("use_skill is within the ceiling via the default allowlist", () => {
    const engine = new PolicyEngine("digest");
    const d = engine.evaluate(hostAction("use_skill"), context());
    expect(d.decision).not.toBe("deny");
  });

  it("gateway_call_tool is denied with the message naming the setting", () => {
    const engine = new PolicyEngine("digest");
    const d = engine.evaluate(hostAction("gateway_call_tool"), context());
    expect(d.decision).toBe("deny");
    if (d.decision === "deny") {
      expect(d.reason).toBe("outside-ceiling");
      expect(d.message).toContain("permissions.trustedHostAllowlist");
    }
  });

  it("an operator allowlist entry admits the named registration", () => {
    const engine = new PolicyEngine("digest");
    const ctx = context({ trustedHostAllowlist: ["use_skill", "gateway_call_tool"] });
    const d = engine.evaluate(hostAction("gateway_call_tool"), ctx);
    expect(d.decision).not.toBe("deny");
  });

  it("matching accepts the operation toolName, not only the registrationId", () => {
    const engine = new PolicyEngine("digest");
    const ctx = context({ trustedHostAllowlist: ["my_custom_tool"] });
    const d = engine.evaluate(hostAction("my_custom_tool"), ctx);
    expect(d.decision).not.toBe("deny");
  });
});
