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
import { buildApprovalChoices, buildApprovalOptions } from "../approval-options.js";
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
  jsFsFallbackOptIn: false,
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
    offeredLifetimes: ["action", "run", "session", "project", "global"],
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
    expect(opt!.supportedLifetimes).toEqual(["action", "run", "session", "project", "global"]);
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

  it("orders options narrowest first with AT MOST one bounded option (MVP shape)", () => {
    const missing = [
      { kind: "read-file" as const, path: "/proj/a.txt" },
      { kind: "process" as const, executable: "/bin/sh", argvPrefix: ["-c", "x"] },
    ];
    const options = build(missing);
    expect(options).not.toBeNull();
    const kinds = options!.map((o) => o.kind);
    expect(kinds[0]).toBe("exact");
    // Product acceptance: the Scope tab shows at most two options — the
    // exact option plus ONE bounded option, even when several widening
    // shapes would be representable.
    expect(kinds.length).toBeLessThanOrEqual(2);
    expect(kinds).toContain("bounded");
  });
});

describe("bounded shape validation (backend enforcement)", () => {
  it("widens process to an executable + FIRST-argv matcher (FR-009)", () => {
    const missing = [
      { kind: "process" as const, executable: "/usr/bin/git", argvPrefix: ["status", "--porcelain"] },
    ];
    const options = build(missing);
    const bounded = options!.find((o) => o.kind === "bounded");
    expect(bounded).toBeDefined();
    // The bounded matcher pins the executable AND the first argv token —
    // never the full argv, never an executable-only widening.
    expect(bounded!.capabilities).toEqual([
      { kind: "process", executable: "/usr/bin/git", argvPrefix: ["status"] },
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
  it("never offers a bounded option for general executors (FR-009)", () => {
    // bash -c is arbitrary execution; pinning a subcommand matcher on a
    // general executor still permits anything, so the widening is omitted.
    const missing = [
      { kind: "process" as const, executable: "/bin/bash", argvPrefix: ["-c", "ls"] },
    ];
    const options = build(missing);
    expect(options!.map((o) => o.kind)).toEqual(["exact"]);
  });

  it("never offers a bounded option for command wrappers (review round 10)", () => {
    // env/sudo/xargs/nohup/timeout run a FOLLOWING command: their first argv
    // token is not the real command, so an argv[0] matcher still permits
    // arbitrary execution. ssh runs arbitrary remote commands on the pinned
    // host; find -exec and awk system() embed execution escape hatches.
    const wrappers = [
      "/usr/bin/env",    // env python …
      "/usr/bin/sudo",   // sudo apt …
      "/usr/bin/xargs",  // xargs rm …
      "/usr/bin/nohup",
      "/usr/bin/timeout", // timeout 30 <anything>
      "/usr/bin/nice",
      "/usr/bin/ssh",    // ssh host <anything>
      "/usr/bin/find",   // find . -exec <anything>
      "/usr/bin/awk",    // awk '… system(…)'
    ];
    for (const executable of wrappers) {
      const missing = [
        { kind: "process" as const, executable, argvPrefix: ["python"] },
      ];
      const options = build(missing);
      expect(options!.map((o) => o.kind), executable).toEqual(["exact"]);
    }
  });

  it("keeps the NARROWEST candidate when bounded candidates are comparable", () => {
    // Two widening shapes are representable: [git status, read-file exact]
    // and [git status, read-root /proj]. The read-root candidate COVERS the
    // other (its root contains the exact read-file), so containment ordering
    // drops the covering candidate and keeps the narrowest — the bounded
    // option is least privilege, never the broader shape (product
    // acceptance).
    const missing = [
      { kind: "read-file" as const, path: "/proj/a.txt" },
      { kind: "process" as const, executable: "/usr/bin/git", argvPrefix: ["status"] },
    ];
    const options = build(missing);
    expect(options).not.toBeNull();
    const bounded = options!.find((o) => o.kind === "bounded");
    expect(bounded).toBeDefined();
    // Same capability SET as the process-widened candidate: git subcommand
    // matcher + the exact read-file (no read-root widening).
    expect(bounded!.capabilities).toHaveLength(2);
    expect(bounded!.capabilities).toEqual(
      expect.arrayContaining([
        { kind: "process", executable: "/usr/bin/git", argvPrefix: ["status"] },
        { kind: "read-file", path: "/proj/a.txt" },
      ]),
    );
  });

  it("omits the bounded choice when candidates are incomparable (never guesses)", () => {
    // Process-widened candidate: [read-file /proj/a.txt, git status].
    // Read-root candidate: [git status --porcelain, read-root /proj].
    // Neither candidate's caps cover the other's (git status does not cover
    // the longer git status --porcelain pin), so the bounded choice is
    // omitted rather than silently picking a widening.
    const missing = [
      { kind: "read-file" as const, path: "/proj/a.txt" },
      { kind: "process" as const, executable: "/usr/bin/git", argvPrefix: ["status", "--porcelain"] },
    ];
    const options = build(missing);
    expect(options).not.toBeNull();
    expect(options!.map((o) => o.kind)).toEqual(["exact"]);
  });
});

describe("complete approval choices (T027)", () => {
  it("exact-only requests offer exact/action + exact/session when a session identity exists", () => {
    const missing = [{ kind: "commit-file" as const, path: "/proj/a.txt" }];
    const options = build(missing)!;
    expect(options.map((o) => o.kind)).toEqual(["exact"]);
    const choices = buildApprovalChoices(options, "sess-1");
    expect(choices).toHaveLength(2);
    const [action, session] = choices;
    expect(action.choiceId).toBe(`${options[0].optionId}::action`);
    expect(action.optionId).toBe(options[0].optionId);
    expect(action.lifetime).toBe("action");
    expect(action.recommended).toBe(true);
    expect(session.choiceId).toBe(`${options[0].optionId}::session`);
    expect(session.optionId).toBe(options[0].optionId);
    expect(session.lifetime).toBe("session");
    expect(session.recommended).toBe(false);
  });

  it("without a session identity only the action choice is issued", () => {
    const missing = [{ kind: "commit-file" as const, path: "/proj/a.txt" }];
    const options = build(missing)!;
    const choices = buildApprovalChoices(options);
    expect(choices).toHaveLength(1);
    expect(choices[0].lifetime).toBe("action");
    expect(choices[0].choiceId).toBe(`${options[0].optionId}::action`);
    expect(choices[0].recommended).toBe(true);
  });

  it("bounded options are session-only: bounded/action is never issued (FR-010)", () => {
    const missing = [{ kind: "read-file" as const, path: "/proj/a.txt" }];
    const options = build(missing)!;
    const bounded = options.find((o) => o.kind === "bounded");
    expect(bounded).toBeDefined();
    const choices = buildApprovalChoices(options, "sess-1");
    const boundedChoices = choices.filter((c) => c.optionId === bounded!.optionId);
    expect(boundedChoices).toHaveLength(1);
    expect(boundedChoices[0].lifetime).toBe("session");
    expect(boundedChoices[0].choiceId).toBe(`${bounded!.optionId}::session`);
  });

  it("mixed capabilities produce one authority bullet per capability", () => {
    const missing = [
      { kind: "process" as const, executable: "/usr/bin/git", argvPrefix: ["status"] },
      { kind: "read-file" as const, path: "/proj/a.txt" },
    ];
    const options = build(missing)!;
    const choices = buildApprovalChoices(options, "sess-1");
    const exactAction = choices.find((c) => c.lifetime === "action");
    expect(exactAction).toBeDefined();
    expect(exactAction!.authoritySummary).toHaveLength(2);
    expect(exactAction!.authoritySummary[0]).toMatch(/^Run `/);
    expect(exactAction!.authoritySummary[1]).toMatch(/^Read `/);
  });

  it("an option whose supportedLifetimes lacks session never gets a session choice", () => {
    const option: ApprovalOption = {
      optionId: "opt-exact",
      actionDigest: "d",
      kind: "exact",
      label: "Only this file",
      capabilities: [{ kind: "commit-file", path: "/proj/a.txt" }],
      supportedLifetimes: ["action"],
    };
    const choices = buildApprovalChoices([option], "sess-1");
    expect(choices).toHaveLength(1);
    expect(choices[0].lifetime).toBe("action");
    expect(choices[0].choiceId).toBe("opt-exact::action");
  });

  it("exact options offer project and global choices when a workspace identity exists", () => {
    const options = build([{ kind: "commit-file" as const, path: "/proj/a.txt" }])!;
    const choices = buildApprovalChoices(options, "sess-1", "ws-1");
    const exact = options.find((o) => o.kind === "exact")!;
    const exactChoices = choices.filter((c) => c.optionId === exact.optionId);
    const lifetimes = exactChoices.map((c) => c.lifetime);
    expect(lifetimes).toEqual(["action", "session", "project", "global"]);
    const project = exactChoices.find((c) => c.lifetime === "project")!;
    expect(project.title).toBe("Allow in this project");
    expect(project.description).toBe("Seepient will remember this permission for this project.");
    const global = exactChoices.find((c) => c.lifetime === "global")!;
    expect(global.title).toBe("Allow always");
    expect(global.description).toBe("Seepient will remember this permission for all projects.");
    expect(project.choiceId).toBe(`${exact.optionId}::project`);
    expect(global.choiceId).toBe(`${exact.optionId}::global`);
  });

  it("bounded options never receive persistent choices — exact-capability grants only", () => {
    const options = build([{ kind: "read-file" as const, path: "/proj/a.txt" }])!;
    const bounded = options.find((o) => o.kind === "bounded")!;
    expect(bounded).toBeDefined();
    const choices = buildApprovalChoices(options, "sess-1", "ws-1");
    const boundedChoices = choices.filter((c) => c.optionId === bounded.optionId);
    expect(boundedChoices.map((c) => c.lifetime)).toEqual(["session"]);
  });

  it("no workspace identity means no persistent choices", () => {
    const options = build([{ kind: "commit-file" as const, path: "/proj/a.txt" }])!;
    const choices = buildApprovalChoices(options, "sess-1");
    expect(choices.every((c) => c.lifetime === "action" || c.lifetime === "session")).toBe(true);
  });
});

describe("plain-language labels (product acceptance)", () => {
  it("exact process options read as consent copy, not policy grammar", () => {
    const missing = [
      { kind: "process" as const, executable: "/bin/sh", argvPrefix: ["-c", "npm test"] },
    ];
    const [exact] = build(missing) ?? [];
    expect(exact!.label).toBe("Only this command — runs exactly the command shown. Any change will ask again.");
  });

  it("bounded process options name the program in plain words", () => {
    const missing = [
      { kind: "process" as const, executable: "/usr/bin/git", argvPrefix: ["status", "--porcelain"] },
    ];
    const bounded = build(missing)!.find((o) => o.kind === "bounded");
    expect(bounded).toBeDefined();
    expect(bounded!.label).toBe(
      "Other commands using this program — allows other commands through this program during the chosen time.",
    );
  });

  it("exact file options use file wording", () => {
    const missing = [{ kind: "commit-file" as const, path: "/proj/a.txt" }];
    const [exact] = build(missing) ?? [];
    expect(exact!.label).toBe("Only this file — changes exactly what's shown. Any change will ask again.");
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
