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
import type { LLMProvider, ProviderResponse } from "../../foundations/contracts/llm.js";
import type { ToolDefinition } from "../../foundations/contracts/tool.js";
import type { ToolResult } from "../../foundations/types.js";
import { createHookExecutor } from "../../domain/hooks.js";

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "seepient-e2e-")));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A provider that issues ONE tool call then stops. */
function fakeProvider(toolName: string, args: Record<string, unknown>): LLMProvider {
  let called = false;
  return {
    async chat(_messages, _tools): Promise<ProviderResponse> {
      if (!called) {
        called = true;
        return {
          content: "",
          tool_calls: [
            {
              id: "tc1",
              name: toolName,
              arguments: JSON.stringify(args),
              type: "function",
            },
          ],
        };
      }
      return { content: "done", tool_calls: [] };
    },
  };
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

/** Build a wired pipeline + the runAgentLoop options to use it. */
async function wirePipeline(opts: {
  broker: ApprovalBroker;
  boundary: ExecutionBoundary;
  ceiling?: CapabilitySet;
  principal?: CapabilitySet;
  policyStore?: LocalPolicyStore;
  auditStore?: LocalAuditStore;
}) {
  const wired = await buildActionLifecycle({
    principalId: "u",
    runId: "r1",
    workspaceRoot: dir,
    modelProviderClass: "openai",
    approvalBroker: opts.broker,
    executionBoundary: opts.boundary,
    policyStore: opts.policyStore ?? new LocalPolicyStore(),
    auditStore: opts.auditStore ?? new LocalAuditStore({ root: dir }),
    deploymentCeiling: opts.ceiling ?? set({ kind: "commit-file", path: join(dir, "a.txt") }),
    principalPolicy: opts.principal ?? set({ kind: "commit-file", path: join(dir, "a.txt") }),
    approvalMode: "manual",
  });
  return wired;
}

/** Common option shape for runAgentLoop. */
function loopOpts(overrides: Partial<Parameters<typeof runAgentLoop>[0]> & { provider: LLMProvider }) {
  return {
    provider: overrides.provider,
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
      principal: set({ kind: "commit-file", path: capPath }),
      ceiling: set({ kind: "commit-file", path: capPath }),
    });
    const provider = fakeProvider("write_file", { path: targetPath, content: "hi" });

    await runAgentLoop(
      loopOpts({
        provider,
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
    const provider = fakeProvider("write_file", { path: targetPath, content: "x" });

    const result = await runAgentLoop(
      loopOpts({
        provider,
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
    const provider = fakeProvider("write_file", { path: targetPath, content: "x" });
    let afterToolCallCount = 0;
    const hooks = createHookExecutor({
      afterToolCall: async () => { afterToolCallCount++; },
    });

    await runAgentLoop(
      loopOpts({
        provider,
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
          requestId: req.requestId,
          actionDigest: req.actionDigest,
          lifetime: "action",
          actorId: "u",
          decidedAt: Date.now(),
        };
      },
    };
    const broker = new InlineApprovalBroker(presenter, { deadlineMs: 5000 });
    const wired = await wirePipeline({
      broker,
      boundary,
      principal: set({ kind: "commit-file", path: capPath }),
      ceiling: set({ kind: "commit-file", path: capPath }),
    });
    const provider = fakeProvider("write_file", { path: targetPath, content: "x" });

    const result = await runAgentLoop(loopOpts({ provider, wiredPipeline: wired }));

    expect(boundary.calls.length).toBe(1); // dispatched exactly once
    const toolStep = result.steps.find((s) => s.type === "tool_call");
    expect(toolStep?.toolCall?.result).toBe("executed-via-boundary");
  });

  it("tools without a registered analyzer fall through to the legacy path", async () => {
    // get_current_datetime has no analyzer → the legacy handler runs.
    const boundary = recordingBoundary({});
    const wired = await wirePipeline({
      broker: new NoneApprovalBroker(),
      boundary,
    });
    const provider = fakeProvider("get_current_datetime", {});

    await runAgentLoop(loopOpts({ provider, wiredPipeline: wired }));

    // Boundary NOT called (no analyzer); the legacy handler ran instead.
    expect(boundary.calls.length).toBe(0);
  });

  it("PolicyStore-approved capability is honored on the next run (Finding #2 fix)", async () => {
    const targetPath = join(dir, "policy.txt");
    const capPath = canonicalize(targetPath);
    const policyStore = new LocalPolicyStore();
    const workspaceId = (await import("../../domain/permissions/policy-store.js")).computeWorkspaceId(dir);

    // Pre-approve the capability directly through the store (simulates
    // /permissions approve taking effect on a subsequent run).
    await policyStore.compareAndSet(
      workspaceId,
      0,
      { version: 1, capabilities: [{ kind: "commit-file", path: capPath }] },
      { kind: "human", authorityId: "operator", authenticatedBy: "cli" },
    );

    const boundary = recordingBoundary({});
    const wired = await wirePipeline({
      broker: new NoneApprovalBroker(), // headless — no interactive approval
      boundary,
      policyStore,
      ceiling: set({ kind: "commit-file", path: capPath }),
      principal: set(), // no caller-supplied policy — must come from the store
    });
    const provider = fakeProvider("write_file", { path: targetPath, content: "x" });

    await runAgentLoop(loopOpts({ provider, wiredPipeline: wired }));

    // The store-approved capability let the call through even though the
    // caller passed no principal policy and the broker would deny.
    expect(boundary.calls.length).toBe(1);
  });
});
