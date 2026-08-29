/**
 * Exact-commit pre-prompt gate tests (spec 019, T006, QS-0.1/0.2).
 *
 * The gate lives in the backend-support section of `PolicyEngine.evaluate`,
 * keyed on operation kind, so it runs for every `commit-files` action
 * regardless of capability coverage — pre-granted write caps (017
 * always-allowed class, config-derived grants) cannot short-circuit it via
 * the early-allow. QS-0.1: deny pre-prompt, no executor round trip; QS-0.2:
 * the env opt-in admits the action and the label drops the exactness claim.
 */
import { describe, it, expect } from "vitest";
import { PolicyEngine } from "../policy-engine.js";
import type {
  Capability,
  CapabilitySet,
  PolicyContext,
  PolicyDecision,
} from "../../../foundations/contracts/permission-policy.js";
import type { PreparedToolAction } from "../../../foundations/contracts/prepared-action.js";
import type {
  ExecutionBackendCapabilities,
} from "../../../foundations/contracts/execution-boundary.js";

/** Narrow to the deny variant so `reason`/`message` are type-visible. */
function expectDeny(d: PolicyDecision): { reason: string; message: string } {
  if (d.decision !== "deny") throw new Error(`expected deny, got ${d.decision}`);
  return { reason: d.reason, message: d.message };
}

/** Backend WITHOUT the helper and WITHOUT the fallback opt-in (QS-0.1). */
const NO_HELPER_BACKEND: ExecutionBackendCapabilities = {
  backend: "local-native",
  capabilityKinds: ["commit-file", "read-file", "process", "model-egress"],
  exactCommit: false,
  jsFsFallbackOptIn: false,
  hostFilteredEgress: true,
  environmentIsolation: true,
  supportedOperationKinds: ["none", "read-file", "commit-files", "process", "broker", "trusted-host"],
};

/** Backend with the interim fallback opt-in advertised (QS-0.2). */
const FALLBACK_OPT_IN_BACKEND: ExecutionBackendCapabilities = {
  ...NO_HELPER_BACKEND,
  jsFsFallbackOptIn: true,
};

function set(...caps: Capability[]): CapabilitySet {
  return { version: 1, capabilities: caps };
}

const EMPTY = set();

function context(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    deploymentCeiling: set({ kind: "commit-file", path: "/proj/a.txt" }),
    principalPolicy: set(),
    runtimeBaseline: set(),
    activeCapabilities: EMPTY,
    immutableDenies: [],
    approvalMode: "manual",
    interaction: { mode: "inline", deadlineMs: 30_000 },
    backendCapabilities: NO_HELPER_BACKEND,
    ...overrides,
  };
}

function writeAction(path = "/proj/a.txt"): PreparedToolAction {
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
              canonicalParent: "/proj",
              basename: "a.txt",
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

/** Non-write action used to prove the gate is keyed on operation kind. */
function readAction(): PreparedToolAction {
  return {
    version: 1,
    actionId: "a2",
    runId: "r1",
    toolCallId: "c2",
    toolName: "read_file",
    principalId: "user",
    argsDigest: "x",
    actionDigest: "d-read",
    risk: "safe",
    effects: [
      {
        kind: "filesystem-read",
        targets: [
          {
            canonicalPath: "/proj/a.txt",
            canonicalParent: "/proj",
            basename: "a.txt",
            exists: true,
            finalSymlink: false,
          },
        ],
        sensitivity: "normal",
      },
    ],
    display: {
      title: "read",
      summary: "/proj/a.txt",
      canonicalTargets: ["/proj/a.txt"],
      effects: ["filesystem-read"],
    },
    operation: {
      kind: "read-file",
      target: {
        canonicalPath: "/proj/a.txt",
        canonicalParent: "/proj",
        basename: "a.txt",
        exists: true,
        finalSymlink: false,
      },
      expected: { exists: true },
      sensitivity: "normal",
    },
  };
}

describe("exact-commit pre-prompt gate (spec 019 FR-002, QS-0.1)", () => {
  it("denies exact-commit-unavailable pre-prompt when the helper is absent and no opt-in", () => {
    const engine = new PolicyEngine("digest");
    const d = engine.evaluate(writeAction(), context());
    expect(d.decision).toBe("deny");
    expect(expectDeny(d).reason).toBe("exact-commit-unavailable");
  });

  it("records the deny in the backend trace layer", () => {
    const engine = new PolicyEngine("digest");
    const d = engine.evaluate(writeAction(), context());
    expect(d.decision).toBe("deny");
    expect(d.trace.evaluatedLayers).toContainEqual({
      layer: "backend",
      result: "deny",
      ruleIds: [],
    });
  });

  it("names the fallback env opt-in verbatim in the denial message", () => {
    const engine = new PolicyEngine("digest");
    const d = engine.evaluate(writeAction(), context());
    expect(d.decision).toBe("deny");
    expect(expectDeny(d).message).toContain("SEEPIENT_ALLOW_JS_FS_FALLBACK=1");
  });

  it("denies even when commit-file capabilities are pre-granted (coverage proof)", () => {
    // 017 always-allowed / config-derived grants put commit-file into the
    // runtime baseline AND active capabilities — the early-allow must not
    // bypass the gate.
    const engine = new PolicyEngine("digest");
    const ctx = context({
      deploymentCeiling: set({ kind: "commit-file", path: "/proj/a.txt" }),
      principalPolicy: set({ kind: "commit-file", path: "/proj/a.txt" }),
      runtimeBaseline: set({ kind: "commit-file", path: "/proj/a.txt" }),
      activeCapabilities: set({ kind: "commit-file", path: "/proj/a.txt" }),
    });
    const d = engine.evaluate(writeAction(), ctx);
    expect(d.decision).toBe("deny");
    expect(expectDeny(d).reason).toBe("exact-commit-unavailable");
  });

  it("still denies in autonomous mode (no mode can approve an unenforceable write)", () => {
    const engine = new PolicyEngine("digest");
    const d = engine.evaluate(writeAction(), context({ approvalMode: "autonomous" }));
    expect(d.decision).toBe("deny");
    expect(expectDeny(d).reason).toBe("exact-commit-unavailable");
  });

  it("still denies in balanced mode (auto-allow must not route to dispatch failure)", () => {
    const engine = new PolicyEngine("digest");
    const d = engine.evaluate(writeAction(), context({ approvalMode: "balanced" }));
    expect(d.decision).toBe("deny");
    expect(expectDeny(d).reason).toBe("exact-commit-unavailable");
  });

  it("allows the action when the fallback opt-in is advertised (QS-0.2)", () => {
    const engine = new PolicyEngine("digest");
    const granted = context({
      backendCapabilities: FALLBACK_OPT_IN_BACKEND,
      principalPolicy: set({ kind: "commit-file", path: "/proj/a.txt" }),
      runtimeBaseline: set({ kind: "commit-file", path: "/proj/a.txt" }),
      activeCapabilities: set({ kind: "commit-file", path: "/proj/a.txt" }),
    });
    const d = engine.evaluate(writeAction(), granted);
    expect(d.decision).toBe("allow");
  });

  it("allows when exactCommit is available", () => {
    const engine = new PolicyEngine("digest");
    const backend: ExecutionBackendCapabilities = {
      ...NO_HELPER_BACKEND,
      exactCommit: true,
    };
    const d = engine.evaluate(
      writeAction(),
      context({
        backendCapabilities: backend,
        principalPolicy: set({ kind: "commit-file", path: "/proj/a.txt" }),
        runtimeBaseline: set({ kind: "commit-file", path: "/proj/a.txt" }),
        activeCapabilities: set({ kind: "commit-file", path: "/proj/a.txt" }),
      }),
    );
    expect(d.decision).toBe("allow");
  });

  it("does not gate non-commit-files operations", () => {
    const engine = new PolicyEngine("digest");
    const ctx = context({
      deploymentCeiling: set(
        { kind: "read-root", root: "/proj" },
        { kind: "read-file", path: "/proj/a.txt" },
      ),
      backendCapabilities: NO_HELPER_BACKEND,
    });
    const d = engine.evaluate(readAction(), ctx);
    expect(d.decision === "deny" && d.reason === "exact-commit-unavailable").toBe(false);
  });
});
