/**
 * P1 PolicyEngine tests (spec 008, T106/T110).
 *
 * Verifies the decision pipeline: allow / needs-approval / deny, immutable
 * denies, backend support, monotonic intersection, and headless denial.
 */
import { describe, it, expect } from "vitest";
import { PolicyEngine, computePolicyDigest } from "../policy-engine.js";
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

/** Process action with a subcommand matcher (FR-009: bounded needs argv). */
function processAction(actionDigest = "d-proc"): PreparedToolAction {
  return {
    version: 1,
    actionId: "a1",
    runId: "r1",
    toolCallId: "c1",
    toolName: "execute_shell_command",
    principalId: "user",
    argsDigest: "x",
    actionDigest,
    risk: "destructive",
    effects: [
      {
        kind: "process-exec",
        command: { executable: "/usr/bin/git", argv: ["status", "--porcelain"], cwd: "/proj" },
        requestedRoots: [],
      },
    ],
    display: {
      title: "run",
      summary: "git status",
      canonicalTargets: [],
      effects: ["process-exec"],
    },
    operation: { kind: "process", command: { executable: "/usr/bin/git", argv: ["status", "--porcelain"], cwd: "/proj" }, roots: [] },
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

  it("needs-approval carries policy-issued options, not a proposed envelope", () => {
    const engine = new PolicyEngine("digest");
    const d = engine.evaluate(writeAction("/proj/a.txt"), context());
    expect(d.decision).toBe("needs-approval");
    if (d.decision === "needs-approval") {
      expect(d.request.actionDigest).toBe("d-/proj/a.txt");
      expect("proposedEnvelope" in d).toBe(false);
      // The backend cannot enforce root-shaped writes, so exactly ONE
      // (exact) option is issued — never a tool-wide or raw fallback.
      expect(d.request.approvalOptions).toHaveLength(1);
      const [opt] = d.request.approvalOptions;
      expect(opt.kind).toBe("exact");
      expect(opt.actionDigest).toBe("d-/proj/a.txt");
      expect(opt.capabilities).toEqual([
        { kind: "commit-file", path: "/proj/a.txt" },
      ]);
      expect(opt.supportedLifetimes).toEqual(["action", "run"]);
      expect(d.request.offeredLifetimes).toEqual(["action", "run"]);
    }
  });

  it("offers the session lifetime only when a stable session identity exists", () => {
    const engine = new PolicyEngine("digest");
    const d = engine.evaluate(writeAction("/proj/a.txt"), context({ sessionId: "sess-1" }));
    expect(d.decision).toBe("needs-approval");
    if (d.decision === "needs-approval") {
      expect(d.request.sessionId).toBe("sess-1");
      expect(d.request.offeredLifetimes).toContain("session");
      for (const opt of d.request.approvalOptions) {
        expect(opt.supportedLifetimes).toContain("session");
      }
    }
  });

  it("offers an exact + bounded pair for process actions the backend enforces", () => {
    const engine = new PolicyEngine("digest");
    const ctx = context({
      deploymentCeiling: set({ kind: "process" }),
      principalPolicy: set({ kind: "process" }),
      runtimeBaseline: set({ kind: "process" }),
    });
    const d = engine.evaluate(processAction(), ctx);
    expect(d.decision).toBe("needs-approval");
    if (d.decision === "needs-approval") {
      const kinds = d.request.approvalOptions.map((o) => o.kind);
      // Narrowest first: exact, then the executable+subcommand bounded option.
      expect(kinds).toEqual(["exact", "bounded"]);
      const exact = d.request.approvalOptions[0];
      const bounded = d.request.approvalOptions[1];
      expect(exact.capabilities).toEqual([
        { kind: "process", executable: "/usr/bin/git", argvPrefix: ["status", "--porcelain"] },
      ]);
      // FR-009: the bounded matcher pins the executable AND the FIRST argv token.
      expect(bounded.capabilities).toEqual([
        { kind: "process", executable: "/usr/bin/git", argvPrefix: ["status"] },
      ]);
      // Option IDs are stable within the request and bound to the digest.
      expect(exact.optionId).toContain("d-proc");
      expect(exact.optionId).not.toBe(bounded.optionId);
    }
  });

  it("needs-approval carries complete approval choices resolved from options (T027)", () => {
    const engine = new PolicyEngine("digest");
    const ctx = context({
      sessionId: "sess-1",
      deploymentCeiling: set({ kind: "process" }),
      principalPolicy: set({ kind: "process" }),
      runtimeBaseline: set({ kind: "process" }),
    });
    const d = engine.evaluate(processAction(), ctx);
    expect(d.decision).toBe("needs-approval");
    if (d.decision === "needs-approval") {
      const { approvalOptions, approvalChoices } = d.request;
      expect(approvalChoices.length).toBeGreaterThan(0);
      const optionIds = new Set(approvalOptions.map((o) => o.optionId));
      for (const choice of approvalChoices) {
        expect(optionIds.has(choice.optionId)).toBe(true);
        expect(choice.choiceId).toBe(`${choice.optionId}::${choice.lifetime}`);
      }
      // Bounded options are session-only (FR-010): bounded/action is never
      // a Domain-issued choice.
      const bounded = approvalOptions.find((o) => o.kind === "bounded");
      expect(bounded).toBeDefined();
      const boundedChoices = approvalChoices.filter((c) => c.optionId === bounded!.optionId);
      expect(boundedChoices).toHaveLength(1);
      expect(boundedChoices[0].lifetime).toBe("session");
      // Exactly one recommended choice: exact/action.
      const recommended = approvalChoices.filter((c) => c.recommended);
      expect(recommended).toHaveLength(1);
      expect(recommended[0].optionId).toBe(approvalOptions[0].optionId);
      expect(recommended[0].lifetime).toBe("action");
    }
  });

  it("offers project/global persistent choices only when a workspace identity exists", () => {
    const engine = new PolicyEngine("digest");
    const base = {
      sessionId: "sess-1",
      deploymentCeiling: set({ kind: "process" }),
      principalPolicy: set({ kind: "process" }),
      runtimeBaseline: set({ kind: "process" }),
    };
    // No workspace identity: session only, no persistent choices.
    const noWs = engine.evaluate(processAction(), context({ ...base }));
    expect(noWs.decision).toBe("needs-approval");
    if (noWs.decision === "needs-approval") {
      expect(noWs.request.workspaceId).toBeUndefined();
      expect(noWs.request.offeredLifetimes).not.toContain("project");
      expect(noWs.request.offeredLifetimes).not.toContain("global");
      expect(noWs.request.approvalChoices.every((c) => c.lifetime === "action" || c.lifetime === "session")).toBe(true);
    }
    // With a workspace identity: project + global choices for the EXACT
    // option only (bounded stays session-only).
    const withWs = engine.evaluate(processAction(), context({ ...base, workspaceId: "ws-1" }));
    expect(withWs.decision).toBe("needs-approval");
    if (withWs.decision === "needs-approval") {
      const { request } = withWs;
      expect(request.workspaceId).toBe("ws-1");
      expect(request.offeredLifetimes).toContain("project");
      expect(request.offeredLifetimes).toContain("global");
      const exact = request.approvalOptions.find((o) => o.kind === "exact")!;
      const exactLifetimes = request.approvalChoices
        .filter((c) => c.optionId === exact.optionId)
        .map((c) => c.lifetime);
      expect(exactLifetimes).toContain("action");
      expect(exactLifetimes).toContain("session");
      expect(exactLifetimes).toContain("project");
      expect(exactLifetimes).toContain("global");
      const bounded = request.approvalOptions.find((o) => o.kind === "bounded")!;
      const boundedLifetimes = request.approvalChoices
        .filter((c) => c.optionId === bounded.optionId)
        .map((c) => c.lifetime);
      expect(boundedLifetimes).toEqual(["session"]);
    }
  });

  it("containment preflight denies process actions on non-isolated backends before prompting", () => {
    const engine = new PolicyEngine("digest");
    const ctx = context({
      deploymentCeiling: set({ kind: "process" }),
      principalPolicy: set({ kind: "process" }),
      runtimeBaseline: set({ kind: "process" }),
      backendCapabilities: { ...LOCAL_BACKEND, environmentIsolation: false },
    });
    const d = engine.evaluate(processAction(), ctx);
    expect(d.decision).toBe("deny");
    if (d.decision === "deny") {
      expect(d.reason).toBe("approval-unavailable");
      expect(d.message).toMatch(/containment/i);
    }
  });

  it("file-only missing capabilities still reach needs-approval without process containment", () => {
    const engine = new PolicyEngine("digest");
    const ctx = context({
      backendCapabilities: { ...LOCAL_BACKEND, environmentIsolation: false },
    });
    const d = engine.evaluate(writeAction("/proj/a.txt"), ctx);
    expect(d.decision).toBe("needs-approval");
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

describe("policy digest deep-canonicalization (reviewer fix #7)", () => {
  it("two different capability sets produce different digests", () => {
    const ctx1 = {
      deploymentCeiling: { version: 1 as const, capabilities: [{ kind: "commit-file" as const, path: "/a" }] },
      principalPolicy: { version: 1 as const, capabilities: [] },
      runtimeBaseline: { version: 1 as const, capabilities: [] },
      activeCapabilities: { version: 1 as const, capabilities: [] },
      immutableDenies: [],
      approvalMode: "manual" as const,
      interaction: { mode: "inline" as const },
      backendCapabilities: { backend: "local-native" as const, capabilityKinds: [], exactCommit: false, hostFilteredEgress: false, environmentIsolation: false, supportedOperationKinds: [] },
    };
    const ctx2 = { ...ctx1, deploymentCeiling: { version: 1 as const, capabilities: [{ kind: "commit-file" as const, path: "/b" }] } };
    expect(computePolicyDigest(ctx1)).not.toBe(computePolicyDigest(ctx2));
  });

  it("key-order-independent: same content → same digest", () => {
    const base = {
      deploymentCeiling: { version: 1 as const, capabilities: [{ kind: "commit-file" as const, path: "/a" }] },
      principalPolicy: { version: 1 as const, capabilities: [] },
      runtimeBaseline: { version: 1 as const, capabilities: [] },
      activeCapabilities: { version: 1 as const, capabilities: [] },
      immutableDenies: [],
      approvalMode: "manual" as const,
      interaction: { mode: "inline" as const },
      backendCapabilities: { backend: "local-native" as const, capabilityKinds: [], exactCommit: false, hostFilteredEgress: false, environmentIsolation: false, supportedOperationKinds: [] },
    };
    // Same content, manually reversed key order at the top level. deepSort
    // canonicalizes both to the same output.
    const reordered = {
      backendCapabilities: base.backendCapabilities,
      interaction: base.interaction,
      approvalMode: base.approvalMode,
      immutableDenies: base.immutableDenies,
      activeCapabilities: base.activeCapabilities,
      runtimeBaseline: base.runtimeBaseline,
      principalPolicy: base.principalPolicy,
      deploymentCeiling: base.deploymentCeiling,
    };
    expect(computePolicyDigest(base)).toBe(computePolicyDigest(reordered as never));
  });
});
