/**
 * Approval-option construction tests (spec 011, T006/T020).
 *
 * Invariants under test:
 *  - exact options carry the request's capabilities exactly, bound to the
 *    action digest, with stable request-bound IDs;
 *  - bounded options exist only for typed shapes the backend can enforce
 *    (process executable, read-root) and only when ceilings/denies permit;
 *  - ordering is narrowest → broadest (exact first);
 *  - no option can be derived from display text; unsupported shapes produce
 *    no selectable option and an unrepresentable request denies as
 *    approval-unavailable at the engine.
 */
import { describe, it, expect } from "vitest";
import { buildApprovalOptions } from "../approval-options.js";
import type {
  ApprovalOption,
  Capability,
  CapabilitySet,
  PolicyContext,
} from "../../../foundations/contracts/permission-policy.js";
import type { PreparedToolAction } from "../../../foundations/contracts/prepared-action.js";
import type { ExecutionBackendCapabilities } from "../../../foundations/contracts/execution-boundary.js";

const LOCAL_BACKEND: ExecutionBackendCapabilities = {
  backend: "local-native",
  capabilityKinds: ["commit-file", "read-file", "process", "model-egress", "read-root"],
  exactCommit: true,
  hostFilteredEgress: true,
  environmentIsolation: true,
  supportedOperationKinds: ["none", "read-file", "commit-files", "process"],
};

function set(...caps: Capability[]): CapabilitySet {
  return { version: 1, capabilities: caps };
}

function ctx(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    deploymentCeiling: set(
      { kind: "commit-file", path: "/proj/a.txt" },
      { kind: "process" },
      { kind: "read-file", path: "/proj/a.txt" },
      { kind: "read-root", root: "/proj" },
    ),
    principalPolicy: set(
      { kind: "commit-file", path: "/proj/a.txt" },
      { kind: "process" },
    ),
    runtimeBaseline: set(),
    activeCapabilities: set(),
    immutableDenies: [],
    approvalMode: "manual",
    interaction: { mode: "inline", deadlineMs: 30_000 },
    backendCapabilities: LOCAL_BACKEND,
    ...overrides,
  };
}

const DIGEST = "digest-abc";

function build(
  missing: Capability[],
  overrides: Partial<PolicyContext> = {},
  actionDigest = DIGEST,
): ApprovalOption[] | null {
  return buildApprovalOptions({
    action: {
      version: 1,
      actionId: "a1",
      runId: "r1",
      toolCallId: "c1",
      toolName: "write_file",
      principalId: "user",
      argsDigest: "x",
      actionDigest,
      risk: "edit",
      effects: [],
      display: {
        title: "Tamper-me",
        summary: "display text must never create authority",
        canonicalTargets: [],
        effects: [],
      },
      operation: { kind: "none", result: { output: "", success: true } },
    } as PreparedToolAction,
    missing,
    context: ctx(overrides),
    offeredLifetimes: ["action", "run", "session"],
  });
}

describe("exact option invariants", () => {
  it("carries the missing capabilities exactly, bound to the action digest", () => {
    const missing = [{ kind: "commit-file" as const, path: "/proj/a.txt" }];
    const [opt] = build(missing) ?? [];
    expect(opt).toBeDefined();
    expect(opt!.kind).toBe("exact");
    expect(opt!.actionDigest).toBe(DIGEST);
    expect(opt!.capabilities).toEqual(missing);
    expect(opt!.supportedLifetimes).toEqual(["action", "run", "session"]);
  });

  it("produces stable request-bound IDs; distinct capability sets differ", () => {
    const missingA = [{ kind: "commit-file" as const, path: "/proj/a.txt" }];
    const missingB = [{ kind: "commit-file" as const, path: "/proj/b.txt" }];
    const a1 = build(missingA)![0];
    const a2 = build(missingA)![0];
    const b = build(missingB)![0];
    expect(a1.optionId).toBe(a2.optionId);
    expect(a1.optionId).not.toBe(b.optionId);
    // Bound to the digest: same caps under a different action differ.
    const otherAction = build(missingA, {}, "digest-other")![0];
    expect(otherAction.optionId).not.toBe(a1.optionId);
  });

  it("orders options narrowest first: exact, then bounded by capability count", () => {
    const missing = [
      { kind: "read-file" as const, path: "/proj/a.txt" },
      { kind: "process" as const, executable: "/bin/sh", argvPrefix: ["-c", "x"] },
    ];
    const options = build(missing);
    expect(options).not.toBeNull();
    const kinds = options!.map((o) => o.kind);
    expect(kinds[0]).toBe("exact");
    expect(kinds).toContain("bounded");
  });
});

describe("bounded shape validation (backend enforcement)", () => {
  it("widens process argv to executable-bound for backends enforcing process", () => {
    const missing = [
      { kind: "process" as const, executable: "/bin/sh", argvPrefix: ["-c", "npm test"] },
    ];
    const options = build(missing);
    const bounded = options!.find((o) => o.kind === "bounded");
    expect(bounded).toBeDefined();
    expect(bounded!.capabilities).toEqual([
      { kind: "process", executable: "/bin/sh" },
    ]);
  });

  it("widens read-file to a canonical-parent read-root when the backend enforces it", () => {
    const missing = [{ kind: "read-file" as const, path: "/proj/sub/a.txt" }];
    const options = build(missing);
    const bounded = options!.find((o) => o.kind === "bounded");
    expect(bounded).toBeDefined();
    expect(bounded!.capabilities).toEqual([
      { kind: "read-root", root: "/proj/sub" },
    ]);
  });

  it("never offers root-shaped WRITE authority the commit broker cannot enforce", () => {
    const missing = [{ kind: "commit-file" as const, path: "/proj/a.txt" }];
    const options = build(missing);
    expect(options).not.toBeNull();
    expect(options!.map((o) => o.kind)).toEqual(["exact"]);
    expect(
      options!.some((o) => o.capabilities.some((c) => c.kind === "write-root")),
    ).toBe(false);
  });

  it("drops bounded candidates the backend does not advertise", () => {
    const missing = [{ kind: "read-file" as const, path: "/proj/a.txt" }];
    const options = build(missing, {
      backendCapabilities: { ...LOCAL_BACKEND, capabilityKinds: ["read-file"] },
    });
    expect(options!.map((o) => o.kind)).toEqual(["exact"]);
  });

  it("drops bounded candidates outside the deployment ceiling", () => {
    // Ceiling covers only the exact file, not the parent root.
    const missing = [{ kind: "read-file" as const, path: "/proj/a.txt" }];
    const options = build(missing, {
      deploymentCeiling: set({ kind: "read-file", path: "/proj/a.txt" }),
    });
    expect(options!.map((o) => o.kind)).toEqual(["exact"]);
  });

  it("drops bounded candidates an immutable deny rule covers", () => {
    // A deny on a path INSIDE the bounded root must forbid the root option.
    const missing = [{ kind: "read-file" as const, path: "/proj/a.txt" }];
    const options = build(missing, {
      immutableDenies: [
        {
          ruleId: "r1",
          effect: "filesystem-read",
          target: "/proj/secret",
          reason: "immutable-deny",
        },
      ],
    });
    expect(options!.map((o) => o.kind)).toEqual(["exact"]);
  });

  it("denies nothing: exact options survive even when all bounded candidates drop", () => {
    const missing = [{ kind: "commit-file" as const, path: "/proj/a.txt" }];
    const options = build(missing, { immutableDenies: [{ ruleId: "r1", effect: "*", reason: "immutable-deny" }] });
    // Exact options are not re-filtered here: immutable denies are enforced
    // by the engine before needs-approval is ever offered.
    expect(options!.map((o) => o.kind)).toEqual(["exact"]);
  });
});

describe("representation failures", () => {
  it("returns null when there is nothing to approve (no missing capabilities)", () => {
    expect(build([])).toBeNull();
  });

  it("display text cannot create a new option", () => {
    const missing = [{ kind: "commit-file" as const, path: "/proj/a.txt" }];
    const options = build(missing);
    // One option per capability shape, regardless of any display data.
    expect(options!.length).toBe(1);
    for (const opt of options!) {
      expect(opt.capabilities).toEqual(missing);
    }
  });
});
