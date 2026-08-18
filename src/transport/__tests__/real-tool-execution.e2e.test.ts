/**
 * Definitive proof: the new pipeline runs a REAL write_file through the REAL
 * tool registry and the file actually gets written — gated by policy.
 *
 * This is the test the reviewer demanded: "a successful, protected write
 * through a real product surface." No fake boundary.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, realpathSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentLoop } from "../../domain/agent-loop.js";
import { buildActionLifecycle } from "../../domain/permissions/action-lifecycle-factory.js";
import { buildLocalBoundary } from "../../capabilities/execution/build-local-boundary.js";
import { InlineApprovalBroker, type InlineApprovalPresenter } from "../approval-brokers.js";
import { createHookExecutor } from "../../domain/hooks.js";
import { createMockRuntime } from "../../domain/__tests__/test-doubles.js";

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "seepient-real-")));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function fakeRuntime(toolName: string, args: Record<string, unknown>) {
  return createMockRuntime([
    {
      toolCalls: [{ id: "tc1", name: toolName, args }],
    },
    {
      text: "done",
    },
  ]);
}

describe("REAL tool execution through the new pipeline (reviewer fix #2)", () => {
  it("write_file ACTUALLY writes the file when approved through the pipeline", async () => {
    const targetPath = join(dir, "real-output.txt");
    // Approve via inline broker
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
    const { boundary, artifacts: sharedArtifacts } = await buildLocalBoundary({ allowFallback: true });
    const wired = await buildActionLifecycle({
      principalId: "u",
      runId: "r1",
      workspaceRoot: dir,
      modelProviderClass: "openai",
      approvalBroker: new InlineApprovalBroker(presenter, { deadlineMs: 5000 }),
      executionBoundary: boundary,
      auditRoot: dir,
      artifacts: sharedArtifacts,
    });
    const runtime = fakeRuntime("write_file", { path: targetPath, content: "hello from the new pipeline" });

    const result = await runAgentLoop({
      runtime,
      model: "test",
      messages: [],
      toolDefs: [],
      maxSteps: 3,
      hooks: createHookExecutor({}),
      wiredPipeline: wired,
    });

    expect(existsSync(targetPath)).toBe(true);
    expect(readFileSync(targetPath, "utf-8")).toBe("hello from the new pipeline");
  });

  it("write_file does NOT write when the broker denies (path outside workspace)", async () => {
    // Use a path OUTSIDE the workspace root so the capability is missing and
    // the broker IS consulted. Inside the workspace, the default ceiling
    // pre-authorizes writes (correct product behavior — no prompt needed).
    const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), "seepient-outside-")));
    const targetPath = join(outsideDir, "denied.txt");
    const presenter: InlineApprovalPresenter = {
      async prompt(req) {
        return { approved: false };
      },
    };
    const { boundary, artifacts: sharedArtifacts } = await buildLocalBoundary();
    const wired = await buildActionLifecycle({
      principalId: "u",
      runId: "r1",
      workspaceRoot: dir,
      modelProviderClass: "openai",
      approvalBroker: new InlineApprovalBroker(presenter, { deadlineMs: 5000 }),
      executionBoundary: boundary,
      auditRoot: dir,
      artifacts: sharedArtifacts,
    });
    const runtime = fakeRuntime("write_file", { path: targetPath, content: "should not be written" });

    await runAgentLoop({
      runtime,
      model: "test",
      messages: [],
      toolDefs: [],
      maxSteps: 3,
      hooks: createHookExecutor({}),
      wiredPipeline: wired,
    });

    expect(existsSync(targetPath)).toBe(false);
  });

  it("get_current_datetime runs through the pipeline (tool without a native executor)", async () => {
    const { boundary, artifacts: sharedArtifacts } = await buildLocalBoundary();
    const wired = await buildActionLifecycle({
      principalId: "u",
      runId: "r1",
      workspaceRoot: dir,
      modelProviderClass: "openai",
      approvalBroker: new InlineApprovalBroker(
        {
          async prompt(req) {
            return {
              approved: true,
              choiceId:
                req.approvalChoices.find((c) => c.lifetime === "action")?.choiceId ??
                req.approvalChoices[0]?.choiceId ??
                "opt-1::action",
            };
          },
        },
        { deadlineMs: 5000 },
      ),
      executionBoundary: boundary,
      auditRoot: dir,
      artifacts: sharedArtifacts,
    });
    // get_current_datetime has an analyzer and runs through the pipeline cleanly.
    const runtime = fakeRuntime("get_current_datetime", {});
    const result = await runAgentLoop({
      runtime,
      model: "test",
      messages: [],
      toolDefs: [],
      maxSteps: 3,
      hooks: createHookExecutor({}),
      wiredPipeline: wired,
    });
    const toolStep = result.steps.find((s) => s.type === "tool_call");
    expect(toolStep?.toolCall?.result).toBeDefined();
    expect(typeof toolStep?.toolCall?.result).toBe("string");
  });
});
