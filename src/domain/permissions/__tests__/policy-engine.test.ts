/**
 * P1 PolicyEngine tests (spec 008, T106/T110).
 *
 * Verifies the decision pipeline: allow / needs-approval / deny, immutable
 * denies, backend support, monotonic intersection, and headless denial.
 */
import { describe, it, expect } from "vitest";
import { PolicyEngine } from "../policy-engine.js";
import type {
  Capability,
  CapabilitySet,
  DenyRule,
  PolicyContext,
} from "../../../foundations/contracts/permission-policy.js";
import type { PreparedToolAction } from "../../../foundations/contracts/prepared-action.js";
import type {
  ExecutionBackendCapabilities,
} from "../../../foundations/contracts/execution-boundary.js";

const LOCAL_BACKEND: ExecutionBackendCapabilities = {
  backend: "local-native",
  capabilityKinds: ["commit-file", "read-file", "process", "model-egress"],
  exactCommit: true,
  hostFilteredEgress: true,
  environmentIsolation: true,
  supportedOperationKinds: ["none", "read-file", "commit-files", "process"],
};

function set(...caps: Capability[]): CapabilitySet {
  return { version: 1, capabilities: caps };
}

const EMPTY = set();

function context(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    deploymentCeiling: set({ kind: "commit-file", path: "/proj/a.txt" }),
    principalPolicy: set({ kind: "commit-file", path: "/proj/a.txt" }),
    runtimeBaseline: set({ kind: "commit-file", path: "/proj/a.txt" }),
    activeCapabilities: EMPTY,
    immutableDenies: [],
    approvalMode: "manual",
    interaction: { mode: "inline", deadlineMs: 30_000 },
    backendCapabilities: LOCAL_BACKEND,
    ...overrides,
  };
}

function writeAction(path: string): PreparedToolAction {
  return {
    version: 1,
    actionId: "a1",
    runId: "r1",
    toolCallId: "c1",
    toolName: "write_file",
    principalId: "user",
    argsDigest: "x",
    actionDigest: "d-" + path,
    risk: "edit",
    effects: [
      {
        kind: "filesystem-write",
        targets: [
          {
            target: {
              canonicalPath: path,
              canonicalParent: path.split("/").slice(0, -1).join("/") || "/",
              basename: path.split("/").pop() ?? "",
              exists: false,
              finalSymlink: false,
            },
            mode: "create",
          },
        ],
      },
    ],
    display: {
      title: "write",
      summary: path,
      canonicalTargets: [path],
      effects: ["filesystem-write"],
    },
    operation: {
      kind: "commit-files",
      commits: [
        {
          destination: {
            canonicalPath: path,
            canonicalParent: "/proj",
            basename: "a.txt",
            exists: false,
            finalSymlink: false,
          },
          content: {
            artifactId: "art1",
            sha256: "deadbeef",
            byteLength: 4,
            mediaType: "text/plain",
          },
        },
      ],
    },
  };
}

describe("PolicyEngine (T106/T110)", () => {
  it("allows when active capability covers the request", () => {
    const engine = new PolicyEngine("digest");
    const ctx = context({
      activeCapabilities: set({ kind: "commit-file", path: "/proj/a.txt" }),
    });
    const d = engine.evaluate(writeAction("/proj/a.txt"), ctx);
    expect(d.decision).toBe("allow");
  });

  it("needs-approval when capability missing but within ceiling", () => {
    const engine = new PolicyEngine("digest");
    const d = engine.evaluate(writeAction("/proj/a.txt"), context());
    expect(d.decision).toBe("needs-approval");
    if (d.decision === "needs-approval") {
      expect(d.request.actionDigest).toBe("d-/proj/a.txt");
      expect(d.proposedEnvelope.capabilities).toEqual([
        { kind: "commit-file", path: "/proj/a.txt" },
      ]);
    }
  });

  it("denies outside-ceiling when path is beyond deployment", () => {
    const engine = new PolicyEngine("digest");
    const d = engine.evaluate(writeAction("/etc/evil"), context());
    expect(d.decision).toBe("deny");
    if (d.decision === "deny") expect(d.reason).toBe("outside-ceiling");
  });

  it("immutable deny wins over allow", () => {
    const engine = new PolicyEngine("digest");
    const denies: DenyRule[] = [
      {
        ruleId: "r1",
        effect: "filesystem-write",
        reason: "immutable-deny",
      },
    ];
    const ctx = context({
      immutableDenies: denies,
      activeCapabilities: set({ kind: "commit-file", path: "/proj/a.txt" }),
    });
    const d = engine.evaluate(writeAction("/proj/a.txt"), ctx);
    expect(d.decision).toBe("deny");
    if (d.decision === "deny") expect(d.reason).toBe("immutable-deny");
  });

  it("backend-unsupported when operation kind not supported", () => {
    const engine = new PolicyEngine("digest");
    const ctx = context({
      backendCapabilities: { ...LOCAL_BACKEND, supportedOperationKinds: ["none"] },
    });
    const d = engine.evaluate(writeAction("/proj/a.txt"), ctx);
    expect(d.decision).toBe("deny");
    if (d.decision === "deny") expect(d.reason).toBe("backend-unsupported");
  });

  it("headless (none) denies needs-approval immediately", () => {
    const engine = new PolicyEngine("digest");
    const ctx = context({ interaction: { mode: "none" } });
    const d = engine.evaluate(writeAction("/proj/a.txt"), ctx);
    expect(d.decision).toBe("deny");
    if (d.decision === "deny") expect(d.reason).toBe("approval-unavailable");
  });

  it("approval-mode never denies needs-approval even in inline mode", () => {
    const engine = new PolicyEngine("digest");
    const ctx = context({ approvalMode: "never" });
    const d = engine.evaluate(writeAction("/proj/a.txt"), ctx);
    expect(d.decision).toBe("deny");
    if (d.decision === "deny") expect(d.reason).toBe("approval-unavailable");
  });

  it("property: outside-ceiling never becomes needs-approval", () => {
    // A path outside both deployment and principal cannot be rescued by approval.
    const engine = new PolicyEngine("digest");
    const ctx = context({
      deploymentCeiling: EMPTY,
      principalPolicy: EMPTY,
    });
    const d = engine.evaluate(writeAction("/proj/a.txt"), ctx);
    expect(d.decision).not.toBe("needs-approval");
  });
});
