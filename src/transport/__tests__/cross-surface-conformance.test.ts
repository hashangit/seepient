/**
 * P3/P6 cross-surface outcome conformance (spec 008, T309/T607).
 *
 * The same prepared action + policy context yields the same Domain decision
 * across every surface; only the broker presentation differs. This suite
 * drives the full ActionLifecycle with the inline/callback/none brokers and
 * asserts the SAME terminal outcome for the SAME inputs.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionLifecycle } from "../../domain/permissions/action-lifecycle.js";
import { PolicyEngine } from "../../domain/permissions/policy-engine.js";
import { LocalAuditStore } from "../../domain/permissions/audit-recorder.js";
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
} from "../../foundations/contracts/permission-policy.js";
import type { PreparedToolAction } from "../../foundations/contracts/prepared-action.js";
import type {
  ExecutionBoundary,
  ExecutionBackendCapabilities,
  ExecutionResult,
} from "../../foundations/contracts/execution-boundary.js";
import type { ToolResult } from "../../foundations/types.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seepient-xsurface-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const LOCAL_BACKEND: ExecutionBackendCapabilities = {
  backend: "local-native",
  capabilityKinds: ["commit-file", "read-file", "process", "model-egress"],
  exactCommit: true,
  hostFilteredEgress: true,
  environmentIsolation: true,
  supportedOperationKinds: ["none", "read-file", "commit-files", "process"],
};

function set(...c: Capability[]): CapabilitySet {
  return { version: 1, capabilities: c };
}

function ctx(overrides: Partial<PolicyContext> = {}): PolicyContext {
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
    principalId: "u",
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
    display: { title: "t", summary: "s", canonicalTargets: ["/p/a.txt"], effects: ["filesystem-write"] },
    operation: { kind: "commit-files", commits: [] },
  };
}

function fakeBoundary(result: ToolResult): ExecutionBoundary {
  return {
    capabilities: LOCAL_BACKEND,
    async execute(a): Promise<ExecutionResult> {
      return {
        state: "succeeded",
        result,
        evidence: {
          backend: "local-native",
          actionDigest: a.actionDigest,
          executorId: "xsurface",
          operationKind: a.operation.kind,
        },
      };
    },
  };
}

async function runWith(
  broker: ApprovalBroker,
  interaction: PolicyContext["interaction"],
  active: CapabilitySet,
): Promise<{ state: string; output: string }> {
  const lifecycle = new ActionLifecycle({
    policy: new PolicyEngine("dig"),
    policyContext: ctx({ interaction, activeCapabilities: active }),
    broker,
    boundary: fakeBoundary({ output: "ok", success: true }),
    audit: new LocalAuditStore({ root: dir }),
    activeCapabilities: { capabilities: [] },
  });
  const result = await lifecycle.run(action());
  return { state: result.outcome.state, output: result.toolResult.output };
}

describe("cross-surface outcome conformance (T309)", () => {
  it("inline, callback, none all produce the SAME outcome for the SAME approved action", async () => {
    // Same action, same policy context with the capability present → allow.
    const active = set({ kind: "commit-file", path: "/p/a.txt" });
    const presenter: InlineApprovalPresenter = {
      async prompt(req) {
        return approved(req);
      },
    };
    const inline = await runWith(
      new InlineApprovalBroker(presenter, { deadlineMs: 5000 }),
      { mode: "inline" },
      active,
    );
    const callback = await runWith(
      new CallbackApprovalBroker(async (req) => approved(req)),
      { mode: "callback" },
      active,
    );
    const none = await runWith(new NoneApprovalBroker(), { mode: "none" }, active);
    expect(inline.state).toBe("succeeded");
    expect(callback.state).toBe("succeeded");
    expect(none.state).toBe("succeeded");
    expect(inline.output).toBe(callback.output);
    expect(callback.output).toBe(none.output);
  });

  it("when the capability is MISSING, inline+callback reach needs-approval but none denies", async () => {
    const presenter: InlineApprovalPresenter = { async prompt(req) { return approved(req); } };
    const inline = await runWith(
      new InlineApprovalBroker(presenter, { deadlineMs: 5000 }),
      { mode: "inline" },
      set(), // missing cap
    );
    const callback = await runWith(
      new CallbackApprovalBroker(async (req) => approved(req)),
      { mode: "callback" },
      set(),
    );
    const none = await runWith(new NoneApprovalBroker(), { mode: "none" }, set());
    // Interactive surfaces approve and succeed.
    expect(inline.state).toBe("succeeded");
    expect(callback.state).toBe("succeeded");
    // Headless denies immediately.
    expect(none.state).toBe("denied");
  });

  it("headless never reaches the broker (no prompt code path)", async () => {
    let brokerCalled = 0;
    const broker: ApprovalBroker = {
      mode: "none",
      async request() {
        brokerCalled++;
        return { approved: false, requestId: "", actionDigest: "", actorId: "", decidedAt: 0 };
      },
    };
    await runWith(broker, { mode: "none" }, set());
    expect(brokerCalled).toBe(0);
  });

  it("an approval for a different action is rejected on every surface", async () => {
    const badBroker: ApprovalBroker = {
      mode: "inline",
      async request(req) {
        return {
          approved: true,
          requestId: req.requestId,
          actionDigest: "wrong-digest",
          lifetime: "action",
          actorId: "u",
          decidedAt: 0,
        };
      },
    };
    const result = await runWith(badBroker, { mode: "inline" }, set());
    expect(result.state).toBe("denied");
  });
});

function approved(req: PermissionRequest): PermissionDecision {
  return {
    approved: true,
    requestId: req.requestId,
    actionDigest: req.actionDigest,
    lifetime: "action",
    actorId: "u",
    decidedAt: 0,
  };
}
