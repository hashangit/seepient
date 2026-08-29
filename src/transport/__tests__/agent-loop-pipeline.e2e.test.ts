/**
 * E2E proof that the spec-008 pipeline is REACHABLE from runAgentLoop.
 *
 * This is the test the scrutiny review demanded: it drives the real
 * runAgentLoop with `wiredPipeline` set and asserts the new path actually
 * governs tool calls. The legacy matrix/grant/autoConfirm branches must be
 * bypassed.
 *
 * What this proves:
 *  - permissionPipeline/wiredPipeline routes through the new path (not dead).
 *  - autoConfirm:true no longer bypasses the pipeline (defect #3 closed).
 *  - a denied tool call does NOT reach the tool handler (defect #1 closed
 *    for the new path).
 *  - afterToolCall does not fire for denials (FR-014 outcome contract).
 *
 * The execution boundary here is a recording fake — that's legitimate because
 * this test verifies ROUTING and POLICY, not enforcement. Enforcement at the
 * boundary is covered by the executor + broker test suites.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Resolve a path the SAME way the analyzer does: realpath the parent, then
 * join the basename. This matches `canonicalizePath` in default-analyzers.ts
 * (which calls realpathSync on the parent directory), so capability paths
 * the test registers agree with the action the analyzer produces.
 *
 * On macOS /tmp → /private/tmp; without this, capability paths registered
 * as /var/folders/... would never match actions canonicalized to
 * /private/var/folders/... and every allow-path test would deny.
 */
function canonicalize(targetPath: string): string {
  return join(realpathSync(join(targetPath, "..")), join(targetPath).split("/").pop()!);
}
import { runAgentLoop } from "../../domain/agent-loop.js";
import { buildActionLifecycle } from "../../domain/permissions/action-lifecycle-factory.js";
import { LocalAuditStore } from "../../domain/permissions/audit-recorder.js";
import { LocalPolicyStore } from "../../domain/permissions/policy-store.js";
import { NoneApprovalBroker, InlineApprovalBroker, type InlineApprovalPresenter } from "../approval-brokers.js";
import type {
  ApprovalBroker,
  Capability,
  CapabilitySet,
} from "../../foundations/contracts/permission-policy.js";
import type {
  ExecutionBoundary,
  ExecutionBackendCapabilities,
  ExecutionResult,
} from "../../foundations/contracts/execution-boundary.js";
import type { ToolResult } from "../../foundations/types.js";
import type { ToolDefinition } from "../../foundations/contracts/tool.js";
import { createHookExecutor } from "../../domain/hooks.js";
import { createMockRuntime } from "../../domain/__tests__/test-doubles.js";

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "seepient-e2e-")));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A provider runtime that issues ONE tool call then stops. */
function fakeRuntime(toolName: string, args: Record<string, unknown>) {
  return createMockRuntime([
    {
      toolCalls: [
        {
          id: "tc1",
          name: toolName,
          args,
        },
      ],
    },
    {
      text: "done",
    },
  ]);
}

/** A boundary that RECORDS every execute() call — the proof instrument. */
function recordingBoundary(opts: {
  result?: ToolResult;
  backend?: ExecutionBackendCapabilities["backend"];
}): ExecutionBoundary & { calls: PreparedActionDigestLog[] } {
  const calls: PreparedActionDigestLog[] = [];
  const backend = opts.backend ?? "local-native";
  const caps: ExecutionBackendCapabilities = {
    backend,
    capabilityKinds: ["commit-file", "read-file", "process", "model-egress"],
    exactCommit: true,
    jsFsFallbackOptIn: false,
    hostFilteredEgress: true,
    environmentIsolation: true,
    supportedOperationKinds: ["none", "read-file", "commit-files", "process"],
  };
  return {
    calls,
    capabilities: caps,
    async execute(action, envelope): Promise<ExecutionResult> {
      calls.push({ actionDigest: action.actionDigest, toolName: action.toolName });
      return {
        state: "succeeded",
        result: opts.result ?? { output: "executed-via-boundary", success: true },
        evidence: {
          backend,
          actionDigest: action.actionDigest,
          executorId: "recording",
          operationKind: action.operation.kind,
        },
      };
    },
  };
}
interface PreparedActionDigestLog {
  actionDigest: string;
  toolName: string;
}

const set = (...c: Capability[]): CapabilitySet => ({ version: 1, capabilities: c });
const defaultEgress: Capability = { kind: "model-egress", providerClass: "*", dataClasses: ["normal", "sensitive"] };

/** Build a wired pipeline + the runAgentLoop options to use it. */
async function wirePipeline(opts: {
  broker: ApprovalBroker;
  boundary: ExecutionBoundary;
  ceiling?: CapabilitySet;
  principal?: CapabilitySet;
  policyStore?: LocalPolicyStore;
  auditStore?: LocalAuditStore;
}) {
  const defaultCeiling = set({ kind: "write-root", root: dir }, { kind: "read-root", root: dir }, defaultEgress);
  const defaultPrincipal = set({ kind: "write-root", root: dir }, { kind: "read-root", root: dir }, defaultEgress);

  const wired = await buildActionLifecycle({
    principalId: "u",
    runId: "r1",
    workspaceRoot: dir,
    modelProviderClass: "openai",
    approvalBroker: opts.broker,
    executionBoundary: opts.boundary,
    policyStore: opts.policyStore ?? new LocalPolicyStore({ root: dir }),
    auditStore: opts.auditStore ?? new LocalAuditStore({ root: dir }),
    deploymentCeiling: opts.ceiling ?? defaultCeiling,
    principalPolicy: opts.principal ?? defaultPrincipal,
    approvalMode: "manual",
  });
  return wired;
}

/** Common option shape for runAgentLoop. */
function loopOpts(overrides: Partial<Parameters<typeof runAgentLoop>[0]> & { runtime: any }) {
  return {
    model: "test-model",
    messages: [],
    toolDefs: [] as ToolDefinition[],
    maxSteps: 5,
    hooks: createHookExecutor({}),
    ...overrides,
  };
}

describe("E2E: runAgentLoop routes through the wired pipeline", () => {
  it("uses the new path: boundary.execute is reached, legacy handler is NOT", async () => {
    // write_file — has an analyzer. The tool's real handler writes to disk;
    // the boundary fake does NOT. If the new path is used, the file is never
    // written; if the legacy path is used, it is.
    const targetPath = join(dir, "out.txt");
    const capPath = canonicalize(targetPath);
    const boundary = recordingBoundary({});
    const wired = await wirePipeline({
      broker: new NoneApprovalBroker(),
      boundary,
      principal: set({ kind: "commit-file", path: capPath }, defaultEgress),
      ceiling: set({ kind: "commit-file", path: capPath }, defaultEgress),
    });
    const runtime = fakeRuntime("write_file", { path: targetPath, content: "hi" });

    await runAgentLoop(
      loopOpts({
        runtime,
        wiredPipeline: wired,
      }),
    );

    // The boundary was called → the new path routed here.
    expect(boundary.calls.length).toBe(1);
    expect(boundary.calls[0].toolName).toBe("write_file");
    // The real write_file handler was NOT invoked (the boundary fake doesn't
    // touch the disk). Prove the file does not exist.
    expect(() => {
      const fs = require("node:fs");
      if (fs.existsSync(targetPath)) throw new Error("file was written by the legacy handler — new path NOT used");
    }).not.toThrow();
  });

  it("autoConfirm:true does NOT bypass the pipeline (defect #3 closed)", async () => {
    // Headless broker denies. With the OLD path, autoConfirm:true would run
    // the tool anyway. With the new path, the denial stands.
    const targetPath = join(dir, "autoconfirm.txt");
    const boundary = recordingBoundary({});
    const wired = await wirePipeline({
      broker: new NoneApprovalBroker(), // denies
      boundary,
      // No matching capability → policy returns needs-approval → broker denies.
      principal: set(),
      ceiling: set(),
    });
    const runtime = fakeRuntime("write_file", { path: targetPath, content: "x" });

    const result = await runAgentLoop(
      loopOpts({
        runtime,
        wiredPipeline: wired,
        autoConfirm: true, // would bypass everything in the legacy path
      }),
    );

    // The boundary was NOT called — the headless broker denied before dispatch.
    expect(boundary.calls.length).toBe(0);
    // And the tool result recorded a denial.
    const toolStep = result.steps.find((s) => s.type === "tool_call");
    expect(toolStep?.toolCall?.result).toMatch(/denied|approval-unavailable/i);
  });

  it("a denied tool call records exactly one terminal outcome and skips afterToolCall", async () => {
    const targetPath = join(dir, "deny.txt");
    const boundary = recordingBoundary({});
    const wired = await wirePipeline({
      broker: new NoneApprovalBroker(),
      boundary,
      principal: set(),
      ceiling: set(),
    });
    const runtime = fakeRuntime("write_file", { path: targetPath, content: "x" });
    let afterToolCallCount = 0;
    const hooks = createHookExecutor({
      afterToolCall: async () => { afterToolCallCount++; },
    });

    await runAgentLoop(
      loopOpts({
        runtime,
        wiredPipeline: wired,
        hooks,
      }),
    );

    expect(boundary.calls.length).toBe(0); // denied
    expect(afterToolCallCount).toBe(0); // FR-014: denials don't fire afterToolCall
  });

  it("an approved tool call via InlineApprovalBroker dispatches exactly once", async () => {
    const targetPath = join(dir, "approve.txt");
    const capPath = canonicalize(targetPath);
    const boundary = recordingBoundary({});
    // Approve the request when it arrives.
    const presenter: InlineApprovalPresenter = {
      async prompt(req) {
        return {
          approved: true,
          choiceId:
            req.approvalChoices.find((c) => c.lifetime === "action")?.choiceId ??
            req.approvalChoices[0]?.choiceId ??
            "opt-1::action",
        };
      },
    };
    const broker = new InlineApprovalBroker(presenter, { deadlineMs: 5000 });
    const defaultEgress: Capability = { kind: "model-egress", providerClass: "*", dataClasses: ["normal", "sensitive"] };
    const wired = await wirePipeline({
      broker,
      boundary,
      principal: set({ kind: "commit-file", path: capPath }, defaultEgress),
      ceiling: set({ kind: "commit-file", path: capPath }, defaultEgress),
    });
    const runtime = fakeRuntime("write_file", { path: targetPath, content: "x" });

    const result = await runAgentLoop(loopOpts({ runtime, wiredPipeline: wired }));

    expect(boundary.calls.length).toBe(1); // dispatched exactly once
    const toolStep = result.steps.find((s) => s.type === "tool_call");
    expect(toolStep?.toolCall?.result).toBe("executed-via-boundary");
  });

  it("tools without a registered analyzer fall through to the legacy path", async () => {
    // A tool with no registered analyzer falls through to the legacy path.
    const boundary = recordingBoundary({});
    const wired = await wirePipeline({
      broker: new NoneApprovalBroker(),
      boundary,
    });
    const runtime = fakeRuntime("unregistered_unknown_tool", {});

    await runAgentLoop(loopOpts({ runtime, wiredPipeline: wired }));

    // Boundary NOT called (no analyzer); the legacy handler ran instead.
    expect(boundary.calls.length).toBe(0);
  });

  it("PolicyStore-approved capability is honored on the next run (Finding #2 fix)", async () => {
    const targetPath = join(dir, "policy.txt");
    const capPath = canonicalize(targetPath);
    const policyStore = new LocalPolicyStore({ root: dir });
    const workspaceId = (await import("../../domain/permissions/policy-store.js")).computeWorkspaceId(dir);

    // Pre-approve the capability directly through the store (simulates
    // /permissions approve taking effect on a subsequent run).
    await policyStore.compareAndSet(
      workspaceId,
      0,
      { version: 1, capabilities: [{ kind: "commit-file", path: capPath }, defaultEgress] },
      { kind: "human", authorityId: "operator", authenticatedBy: "cli" },
    );

    const boundary = recordingBoundary({});
    const wired = await wirePipeline({
      broker: new NoneApprovalBroker(), // headless — no interactive approval
      boundary,
      policyStore,
      ceiling: set({ kind: "commit-file", path: capPath }, defaultEgress),
      principal: set(), // no caller-supplied policy — must come from the store
    });
    const runtime = fakeRuntime("write_file", { path: targetPath, content: "x" });

    await runAgentLoop(loopOpts({ runtime, wiredPipeline: wired }));

    // The store-approved capability let the call through even though the
    // caller passed no principal policy and the broker would deny.
    expect(boundary.calls.length).toBe(1);
  });

  it("a deployment ceiling omitting model-egress denies execution or redacts output (monotonic intersection preserved)", async () => {
    const targetPath = join(dir, "restrictive.txt");
    const capPath = canonicalize(targetPath);
    const boundary = recordingBoundary({});
    // Explicit ceiling that ONLY allows commit-file (NO model-egress)
    const wired = await wirePipeline({
      broker: new NoneApprovalBroker(),
      boundary,
      ceiling: set({ kind: "commit-file", path: capPath }),
      principal: set({ kind: "commit-file", path: capPath }),
    });
    const runtime = fakeRuntime("write_file", { path: targetPath, content: "x" });

    const result = await runAgentLoop(loopOpts({ runtime, wiredPipeline: wired }));
    // Because deploymentCeiling lacks model-egress, policy denies execution up front!
    expect(boundary.calls.length).toBe(0);
    const toolMsg = result.messages.find((m) => m.role === "tool");
    expect(toolMsg?.content).toContain("denied");
  });
});
