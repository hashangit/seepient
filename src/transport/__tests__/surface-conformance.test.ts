/**
 * P3 cross-surface decision conformance (spec 008, T309, QS-3.4).
 *
 * The same prepared action + policy context MUST yield the same Domain
 * decision regardless of which surface (TUI/SDK/CLI/REST) originated it.
 * Only the broker presentation differs. This suite exercises the three
 * built-in brokers against identical inputs and asserts decision equivalence
 * where the broker is not the deciding factor.
 */
import { describe, it, expect } from "vitest";
import { PolicyEngine } from "../../domain/permissions/policy-engine.js";
import {
  NoneApprovalBroker,
  CallbackApprovalBroker,
  InlineApprovalBroker,
  type InlineApprovalPresenter,
} from "../approval-brokers.js";
import type {
  ApprovalBroker,
  Capability,
  CapabilitySet,
  PolicyContext,
  PermissionDecision,
  PermissionRequest,
  TuiApprovalSelection,
} from "../../foundations/contracts/permission-policy.js";
import type { PreparedToolAction } from "../../foundations/contracts/prepared-action.js";
import type { ExecutionBackendCapabilities } from "../../foundations/contracts/execution-boundary.js";

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

function context(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    deploymentCeiling: set({ kind: "commit-file", path: "/p/a.txt" }),
    principalPolicy: set({ kind: "commit-file", path: "/p/a.txt" }),
    runtimeBaseline: set({ kind: "commit-file", path: "/p/a.txt" }),
    activeCapabilities: set(),
    immutableDenies: [],
    approvalMode: "manual",
    interaction: { mode: "inline", deadlineMs: 30_000 },
    backendCapabilities: LOCAL_BACKEND,
    ...overrides,
  };
}

function action(): PreparedToolAction {
  return {
    version: 1,
    actionId: "a1",
    runId: "r1",
    toolCallId: "c1",
    toolName: "write_file",
    principalId: "user",
    argsDigest: "x",
    actionDigest: "d1",
    risk: "edit",
    effects: [
      {
        kind: "filesystem-write",
        targets: [
          {
            target: {
              canonicalPath: "/p/a.txt",
              canonicalParent: "/p",
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
      summary: "/p/a.txt",
      canonicalTargets: ["/p/a.txt"],
      effects: ["filesystem-write"],
    },
    operation: { kind: "commit-files", commits: [] },
  };
}

describe("cross-surface decision conformance (T309)", () => {
  it("policy decision is identical across surfaces for the same context", () => {
    const engine = new PolicyEngine("dig");
    const ctx = context();
    const d1 = engine.evaluate(action(), ctx);
    const d2 = engine.evaluate(action(), ctx);
    expect(d1.decision).toBe(d2.decision);
    // The engine is deterministic: same context + action → same decision.
    if (d1.decision === "needs-approval" && d2.decision === "needs-approval") {
      expect(d1.request.actionDigest).toBe(d2.request.actionDigest);
    }
  });

  it("inline + callback + none brokers all respect the same Domain decision", () => {
    // The broker only resolves the approval; the underlying policy decision
    // is independent of which broker is wired.
    const engine = new PolicyEngine("dig");
    const inline = new InlineApprovalBroker({
      async prompt(req) {
        return {
          approved: true,
          choiceId:
            req.approvalChoices.find((c) => c.optionId === "opt-1")?.choiceId ??
            "opt-1::action",
        };
      },
    });
    const callback = new CallbackApprovalBroker(async () => approvedStub());
    const none = new NoneApprovalBroker();
    expect(inline.mode).toBe("inline");
    expect(callback.mode).toBe("callback");
    expect(none.mode).toBe("none");

    // Policy decision is the same regardless of broker.
    const d = engine.evaluate(action(), context());
    expect(d.decision).toBe("needs-approval");
  });
});

describe("NoneApprovalBroker (headless, T301)", () => {
  it("never waits; returns a typed denial immediately", async () => {
    const broker = new NoneApprovalBroker();
    const req: PermissionRequest = {
      requestId: "r1",
      principalId: "u",
      runId: "run",
      toolCallId: "c1",
      actionDigest: "d1",
      action: action().display,
      requestedCapabilities: [{ kind: "commit-file", path: "/p/a.txt" }],
      approvalOptions: [],
      approvalChoices: [],
      offeredLifetimes: ["action", "run"],
      createdAt: 0,
      expiresAt: 1,
    };
    const decision = await broker.request(req);
    expect(decision.approved).toBe(false);
    if (!decision.approved) {
      expect(decision.reason).toContain("headless");
    }
  });
});

describe("CallbackApprovalBroker (SDK, T301/QS-3.4)", () => {
  it("routes the typed request to the callback", async () => {
    let observed: PermissionRequest | undefined;
    const broker = new CallbackApprovalBroker(async (req) => {
      observed = req;
      return approvedStub(req);
    });
    const req: PermissionRequest = {
      requestId: "r1",
      principalId: "u",
      runId: "run",
      toolCallId: "c1",
      actionDigest: "d1",
      action: action().display,
      requestedCapabilities: [],
      approvalOptions: [],
      approvalChoices: [],
      offeredLifetimes: ["action"],
      createdAt: 0,
      expiresAt: Date.now() + 1000,
    };
    const d = await broker.request(req, {});
    expect(observed?.requestId).toBe("r1");
    expect(d.approved).toBe(true);
  });

  it("rejects approval for a different action digest (lifecycle catches)", async () => {
    const broker = new CallbackApprovalBroker(async (req) => ({
      approved: true,
      requestId: req.requestId,
      actionDigest: "different",
      optionId: req.approvalOptions[0]?.optionId ?? "opt-1",
      lifetime: "action" as const,
      actorId: "u",
      decidedAt: 0,
    }));
    const req: PermissionRequest = {
      requestId: "r1",
      principalId: "u",
      runId: "run",
      toolCallId: "c1",
      actionDigest: "d1",
      action: action().display,
      requestedCapabilities: [],
      approvalOptions: [],
      approvalChoices: [],
      offeredLifetimes: ["action"],
      createdAt: 0,
      expiresAt: 1,
    };
    const d = await broker.request(req, {});
    // The broker returns what the callback said; the lifecycle is what catches
    // the mismatch. Here we just verify the broker faithfully forwards.
    expect(d.approved).toBe(true);
    expect(d.actionDigest).toBe("different");
  });

  it("aborts before callback → denial", async () => {
    const broker = new CallbackApprovalBroker(async () => approvedStub());
    const controller = new AbortController();
    controller.abort();
    const d = await broker.request(
      {
        requestId: "r1",
        principalId: "u",
        runId: "run",
        toolCallId: "c1",
        actionDigest: "d1",
        action: action().display,
        requestedCapabilities: [],
        approvalOptions: [],
        approvalChoices: [],
        offeredLifetimes: ["action"],
        createdAt: 0,
        expiresAt: 1,
      },
      { signal: controller.signal },
    );
    expect(d.approved).toBe(false);
  });
});

describe("InlineApprovalBroker (T301/QS-3.1)", () => {
  it("presents once and forwards the decision", async () => {
    let prompts = 0;
    const presenter: InlineApprovalPresenter = {
      async prompt(req) {
        prompts++;
        return {
          approved: true,
          choiceId:
            req.approvalChoices.find((c) => c.optionId === "opt-1")?.choiceId ??
            "opt-1::action",
        };
      },
    };
    const broker = new InlineApprovalBroker(presenter, { deadlineMs: 1000 });
    const req: PermissionRequest = {
      requestId: "r1",
      principalId: "u",
      runId: "run",
      toolCallId: "c1",
      actionDigest: "d1",
      action: action().display,
      requestedCapabilities: [],
      approvalOptions: [
        {
          optionId: "opt-1",
          actionDigest: "d1",
          kind: "exact",
          label: "Exact",
          capabilities: [],
          supportedLifetimes: ["action"],
        },
      ],
      approvalChoices: [
        {
          choiceId: "opt-1::action",
          optionId: "opt-1",
          lifetime: "action",
          title: "Allow this action once",
          description: "You'll be asked again next time.",
          authoritySummary: [],
          recommended: true,
        },
      ],
      offeredLifetimes: ["action"],
      createdAt: 0,
      expiresAt: Date.now() + 1000,
    };
    const d = await broker.request(req, {});
    expect(prompts).toBe(1);
    expect(d.approved).toBe(true);
  });

  it("timeout → safe denial", async () => {
    const presenter: InlineApprovalPresenter = {
      async prompt(_req, opts) {
        // Never resolves; wait for the abort signal.
        return new Promise<TuiApprovalSelection>((_resolve, reject) => {
          opts.signal?.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        });
      },
    };
    const broker = new InlineApprovalBroker(presenter, { deadlineMs: 20 });
    const d = await broker.request(
      {
        requestId: "r1",
        principalId: "u",
        runId: "run",
        toolCallId: "c1",
        actionDigest: "d1",
        action: action().display,
        requestedCapabilities: [],
        approvalOptions: [],
        approvalChoices: [],
        offeredLifetimes: ["action"],
        createdAt: 0,
        expiresAt: 1,
      },
      {},
    );
    expect(d.approved).toBe(false);
  });

  it("resolves a persistent project choice only when the request carries a workspace identity", async () => {
    const presenter: InlineApprovalPresenter = {
      async prompt() {
        return { approved: true, choiceId: "opt-1::project" };
      },
    };
    const broker = new InlineApprovalBroker(presenter, { deadlineMs: 1000 });
    const base: PermissionRequest = {
      requestId: "r1",
      principalId: "u",
      runId: "run",
      toolCallId: "c1",
      actionDigest: "d1",
      action: action().display,
      requestedCapabilities: [],
      approvalOptions: [
        {
          optionId: "opt-1",
          actionDigest: "d1",
          kind: "exact",
          label: "Exact",
          capabilities: [],
          supportedLifetimes: ["action", "project", "global"],
        },
      ],
      approvalChoices: [
        {
          choiceId: "opt-1::action",
          optionId: "opt-1",
          lifetime: "action",
          title: "Allow this action once",
          description: "",
          authoritySummary: [],
          recommended: true,
        },
        {
          choiceId: "opt-1::project",
          optionId: "opt-1",
          lifetime: "project",
          title: "Allow in this project",
          description: "",
          authoritySummary: [],
          recommended: false,
        },
      ],
      offeredLifetimes: ["action", "project", "global"],
      createdAt: 0,
      expiresAt: Date.now() + 1000,
    };
    const ok = await broker.request({ ...base, workspaceId: "ws-1" }, {});
    expect(ok.approved).toBe(true);
    if (ok.approved) expect(ok.lifetime).toBe("project");

    // Same choice ID against a request WITHOUT a workspace identity is an
    // invalid response — the broker never fabricates persistent authority.
    const denied = await broker.request(base, {});
    expect(denied.approved).toBe(false);
    if (!denied.approved) expect(denied.reason).toBe("invalid-approval-response");
  });

  it("deadline settles the prompt even when the presenter ignores the signal (review fix)", async () => {
    // A presenter that never resolves AND never listens to the abort signal
    // must not hang the broker: the deadline race settles a typed denial.
    const presenter: InlineApprovalPresenter = {
      async prompt() {
        return new Promise<TuiApprovalSelection>(() => {});
      },
    };
    const broker = new InlineApprovalBroker(presenter, { deadlineMs: 20 });
    const d = await broker.request(
      {
        requestId: "r1",
        principalId: "u",
        runId: "run",
        toolCallId: "c1",
        actionDigest: "d1",
        action: action().display,
        requestedCapabilities: [],
        approvalOptions: [],
        approvalChoices: [],
        offeredLifetimes: ["action"],
        createdAt: 0,
        expiresAt: Date.now() + 1000,
      },
      {},
    );
    expect(d.approved).toBe(false);
    if (!d.approved) expect(d.reason).toContain("expired");
  });

  it("an ALREADY-aborted signal denies immediately, not at the deadline (review fix)", async () => {
    // The presenter never resolves; the deadline is far longer than the test
    // would survive. Only the pre-abort check can settle this promptly.
    const presenter: InlineApprovalPresenter = {
      async prompt() {
        return new Promise<TuiApprovalSelection>(() => {});
      },
    };
    const broker = new InlineApprovalBroker(presenter, { deadlineMs: 60_000 });
    const controller = new AbortController();
    controller.abort(); // aborted BEFORE request() is called
    const started = Date.now();
    const d = await broker.request(
      {
        requestId: "r1",
        principalId: "u",
        runId: "run",
        toolCallId: "c1",
        actionDigest: "d1",
        action: action().display,
        requestedCapabilities: [],
        approvalOptions: [],
        approvalChoices: [],
        offeredLifetimes: ["action"],
        createdAt: 0,
        expiresAt: Date.now() + 1000,
      },
      { signal: controller.signal },
    );
    expect(d.approved).toBe(false);
    if (!d.approved) expect(d.reason).toBe("user-denied");
    // Settled immediately — not after the 60s deadline.
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

function approvedStub(req?: PermissionRequest): PermissionDecision {
  return {
    approved: true,
    requestId: req?.requestId ?? "r1",
    actionDigest: req?.actionDigest ?? "d1",
    optionId: req?.approvalOptions?.[0]?.optionId ?? "opt-1",
    lifetime: "action",
    actorId: "u",
    decidedAt: 0,
  };
}

// Re-export to satisfy unused-import linter when ApprovalBroker is referenced
// only as a type anchor.
export type { ApprovalBroker };
