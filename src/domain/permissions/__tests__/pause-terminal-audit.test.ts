/**
 * 029 gate repair round 3 (P2.4) — the engine-side terminal-audit port for
 * governed pauses.
 *
 * A pause suspends the lifecycle BEFORE recordTerminal (the boundary raises
 * ToolSuspendedError), leaving a non-terminal trail. When the pause ends by
 * denial, cancellation, or expiry OUTSIDE the resumed dispatch, the typed
 * port closes the suspended action's audit with exactly ONE terminal
 * outcome. A resumed approval instead yields the normal lifecycle terminal —
 * and a later port call must not add a second one.
 */
import { describe, expect, it } from "vitest";
import { ActionLifecycle } from "../action-lifecycle.js";
import { recordSuspendedPauseTerminal } from "../action-lifecycle.js";
import { PolicyEngine } from "../policy-engine.js";
import { InMemoryAuditStore } from "../in-memory-stores.js";
import { ToolSuspendedError } from "../../../foundations/errors.js";
import type { PermissionDecision, PolicyContext } from "../../../foundations/contracts/permission-policy.js";
import type {
  ExecutionBackendCapabilities,
  ExecutionBoundary,
  ExecutionResult,
} from "../../../foundations/contracts/execution-boundary.js";
import type { PreparedToolAction } from "../../../foundations/contracts/prepared-action.js";
import type { ToolResult } from "../../../foundations/types.js";

const LOCAL_BACKEND: ExecutionBackendCapabilities = {
  backend: "local-native",
  capabilityKinds: ["commit-file", "read-file", "process", "model-egress"],
  exactCommit: true,
  hostFilteredEgress: true,
  environmentIsolation: true,
  supportedOperationKinds: ["none", "read-file", "commit-files", "process"],
};

function policyCtx(): PolicyContext {
  return {
    deploymentCeiling: { version: 1, capabilities: [] },
    principalPolicy: { version: 1, capabilities: [] },
    runtimeBaseline: { version: 1, capabilities: [] },
    activeCapabilities: { version: 1, capabilities: [] },
    immutableDenies: [],
    approvalMode: "manual",
    interaction: { mode: "inline", deadlineMs: 30_000 },
    backendCapabilities: LOCAL_BACKEND,
  };
}

function pauseAction(): PreparedToolAction {
  return {
    version: 1,
    actionId: "pause-action-1",
    runId: "run-1",
    toolCallId: "call_1",
    toolName: "governed_tool",
    principalId: "user",
    argsDigest: "args",
    actionDigest: "digest-1",
    risk: "edit",
    effects: [],
    display: {
      title: "governed",
      summary: "governed",
      canonicalTargets: [],
      effects: [],
    },
    operation: { kind: "none", result: { output: "", success: true } },
  };
}

/** Broker that approves without interaction (the resumed-dispatch posture). */
const autoBroker = {
  mode: "inline" as const,
  async request(req: { requestId: string; actionDigest: string }): Promise<PermissionDecision> {
    return {
      approved: true,
      requestId: req.requestId,
      actionDigest: req.actionDigest,
      optionId: "approve",
      lifetime: "action" as const,
      capabilities: [],
      selected: "approve",
    } as unknown as PermissionDecision;
  },
};

/** Boundary that suspends first, then succeeds (the resumed dispatch). */
function suspendingThenSucceedingBoundary(): ExecutionBoundary {
  let calls = 0;
  return {
    capabilities: LOCAL_BACKEND,
    async execute(
      _action: PreparedToolAction,
      _env: unknown,
    ): Promise<ExecutionResult> {
      calls += 1;
      if (calls === 1) throw new ToolSuspendedError("permission", "pause-token-1");
      const result: ToolResult = { output: "done", success: true };
      return {
        state: "succeeded",
        result,
        evidence: {
          backend: "local-native",
          actionDigest: _action.actionDigest,
          executorId: "test",
          operationKind: _action.operation.kind,
        },
      };
    },
  };
}

async function buildLifecycle(audit = new InMemoryAuditStore()) {
  const policy = new PolicyEngine("policy-digest-test");
  const lifecycle = new ActionLifecycle({
    policy,
    policyContext: policyCtx(),
    broker: autoBroker,
    boundary: suspendingThenSucceedingBoundary(),
    audit,
    activeCapabilities: { capabilities: [] },
  });
  return { lifecycle, audit };
}

describe("P2.4 — engine-side terminal audit for governed pauses", () => {
  it("a suspension leaves a non-terminal awaiting-approval marker and NO terminal", async () => {
    const { lifecycle, audit } = await buildLifecycle();
    // The lifecycle rethrows the suspension (the loop's suspension seam ends
    // the turn) — the marker is recorded before the rethrow.
    await expect(lifecycle.run(pauseAction())).rejects.toBeInstanceOf(ToolSuspendedError);
    expect(await audit.getTerminal("pause-action-1")).toBeUndefined();
    const states = audit["appends"].map((a) => a.event.state);
    expect(states).toContain("dispatched");
    expect(states).toContain("awaiting-approval");
    expect(states).not.toContain("succeeded");
    expect(states).not.toContain("failed");
    expect(states).not.toContain("cancelled");
  });

  it("deny: the port records exactly ONE failed terminal (user-denied); a second call adds nothing", async () => {
    const { lifecycle, audit } = await buildLifecycle();
    await expect(lifecycle.run(pauseAction())).rejects.toBeInstanceOf(ToolSuspendedError);
    const action = pauseAction();
    const first = await lifecycle.recordPauseTerminal(action, "denied");
    expect(first).toBe("written");
    const terminal = await audit.getTerminal("pause-action-1");
    expect(terminal?.state).toBe("failed");
    expect(terminal?.reason).toBe("user-denied");
    // Exactly one terminal across the whole trail.
    const terminalStates = audit["appends"]
      .map((a) => a.event.state)
      .filter((s) => s === "succeeded" || s === "failed" || s === "cancelled");
    expect(terminalStates).toEqual(["failed"]);
    expect(await lifecycle.recordPauseTerminal(action, "cancelled")).toBe("already-terminal");
    expect(terminalStates).toEqual(["failed"]);
  });

  it("cancel: the port records exactly ONE cancelled terminal", async () => {
    const { lifecycle, audit } = await buildLifecycle();
    await expect(lifecycle.run(pauseAction())).rejects.toBeInstanceOf(ToolSuspendedError);
    const written = await lifecycle.recordPauseTerminal(pauseAction(), "cancelled");
    expect(written).toBe("written");
    expect((await audit.getTerminal("pause-action-1"))?.state).toBe("cancelled");
  });

  it("expire: the standalone port records exactly ONE cancelled terminal (approval-expired)", async () => {
    const audit = new InMemoryAuditStore();
    const { lifecycle } = await buildLifecycle(audit);
    await expect(lifecycle.run(pauseAction())).rejects.toBeInstanceOf(ToolSuspendedError);
    // Out-of-session form: only the parked binding + a store are known.
    const written = await recordSuspendedPauseTerminal({
      audit,
      binding: {
        actionId: "pause-action-1",
        actionDigest: "digest-1",
        principalId: "user",
        runId: "run-1",
      },
      terminal: "expired",
      policyDigest: "policy-digest",
    });
    expect(written).toBe("written");
    const terminal = await audit.getTerminal("pause-action-1");
    expect(terminal?.state).toBe("cancelled");
    expect(terminal?.reason).toBe("approval-expired");
    expect(
      await recordSuspendedPauseTerminal({
        audit,
        binding: {
          actionId: "pause-action-1",
          actionDigest: "digest-1",
          principalId: "user",
          runId: "run-1",
        },
        terminal: "expired",
        policyDigest: "policy-digest",
      }),
    ).toBe("already-terminal");
  });

  it("a resumed approval yields the normal lifecycle terminal; the port adds NO second one", async () => {
    const { lifecycle, audit } = await buildLifecycle();
    // First dispatch suspends…
    await expect(lifecycle.run(pauseAction())).rejects.toBeInstanceOf(ToolSuspendedError);
    expect(await audit.getTerminal("pause-action-1")).toBeUndefined();
    // …the pause is approved, and the SAME action re-dispatches to success.
    const resumed = await lifecycle.run(pauseAction());
    expect(resumed.outcome.state).toBe("succeeded");
    expect((await audit.getTerminal("pause-action-1"))?.state).toBe("succeeded");
    const terminalStates = audit["appends"]
      .map((a) => a.event.state)
      .filter((s) => s === "succeeded" || s === "failed" || s === "cancelled");
    expect(terminalStates).toEqual(["succeeded"]);
    // The port must not add a second terminal after the real outcome.
    expect(await lifecycle.recordPauseTerminal(pauseAction(), "denied")).toBe("already-terminal");
    expect(terminalStates).toEqual(["succeeded"]);
  });
});
