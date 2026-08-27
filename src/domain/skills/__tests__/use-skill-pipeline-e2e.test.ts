import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, realpathSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentLoop } from "../../agent-loop.js";
import { buildActionLifecycle } from "../../permissions/action-lifecycle-factory.js";
import { buildLocalBoundary } from "../../../capabilities/execution/build-local-boundary.js";
import type { ApprovalBroker } from "../../../foundations/contracts/permission-policy.js";
import { initializeSkillRegistry } from "../../../capabilities/skills/index.js";
import { createHookExecutor } from "../../hooks.js";
import { createMockRuntime } from "../../__tests__/test-doubles.js";
import { getAllToolDefinitions } from "../../tool-executor.js";

const NOOP_BROKER: ApprovalBroker = {
  mode: "none",
  request: async (req) => ({
    approved: false,
    requestId: req.requestId,
    actionDigest: req.actionDigest,
    actorId: "test",
    reason: "noop",
    decidedAt: Date.now(),
  }),
};

describe("use_skill pipeline end-to-end acceptance", () => {
  let dir: string;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "seepient-skill-e2e-")));
    const skillsDir = join(dir, ".seepient", "skills", "hello-ops");
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(
      join(skillsDir, "SKILL.md"),
      `---
name: hello-ops
description: Operations skill for testing
---
# Hello Ops
Instructions on how to operate the hello system.
`,
      "utf8",
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("activates installed skill through the permission pipeline and returns activated content", async () => {
    const registry = await initializeSkillRegistry(dir);
    expect(registry.get("hello-ops")).toBeDefined();

    const { boundary, artifacts } = await buildLocalBoundary({
      workspaceRoot: dir,
    });

    const wiredPipeline = await buildActionLifecycle({
      principalId: "user-test",
      runId: "run-e2e-skill",
      workspaceRoot: dir,
      approvalBroker: NOOP_BROKER,
      executionBoundary: boundary,
      artifacts,
      auditRoot: join(dir, "audit"),
      consentMode: "edit-enabled",
    });

    const runtime = createMockRuntime([
      {
        toolCalls: [
          {
            id: "tc_skill_1",
            name: "use_skill",
            args: { skill_name: "hello-ops" },
          },
        ],
      },
      {
        text: "I have activated the hello-ops skill.",
      },
    ]);

    const result = await runAgentLoop({
      messages: [{ id: "m1", role: "user", content: "activate hello-ops", timestamp: Date.now() }],
      systemPrompt: "You are a test agent.",
      toolDefs: getAllToolDefinitions(),
      config: { autoConfirm: true },
      runtime,
      hooks: createHookExecutor({}),
      maxSteps: 5,
      wiredPipeline,
    });

    expect(result.finishReason).toBe("stop");
    const toolStep = result.steps.find((s) => s.type === "tool_call");
    expect(toolStep).toBeDefined();
    if (toolStep && toolStep.type === "tool_call") {
      expect(toolStep.toolCall?.name).toBe("use_skill");
      expect(toolStep.toolCall?.result).toContain("# hello-ops Skill Activated");
      expect(toolStep.toolCall?.result).toContain("Instructions on how to operate the hello system.");
    }
  });

  it("gracefully returns not found error when model requests unknown skill", async () => {
    const registry = await initializeSkillRegistry(dir);
    expect(registry.get("hello-ops")).toBeDefined();

    const { boundary, artifacts } = await buildLocalBoundary({
      workspaceRoot: dir,
    });

    const wiredPipeline = await buildActionLifecycle({
      principalId: "user-test",
      runId: "run-e2e-skill-missing",
      workspaceRoot: dir,
      approvalBroker: NOOP_BROKER,
      executionBoundary: boundary,
      artifacts,
      auditRoot: join(dir, "audit"),
      consentMode: "edit-enabled",
    });

    const runtime = createMockRuntime([
      {
        toolCalls: [
          {
            id: "tc_skill_2",
            name: "use_skill",
            args: { skill_name: "missing-skill" },
          },
        ],
      },
      {
        text: "Skill was not found.",
      },
    ]);

    const result = await runAgentLoop({
      messages: [{ id: "m1", role: "user", content: "activate missing", timestamp: Date.now() }],
      systemPrompt: "You are a test agent.",
      toolDefs: getAllToolDefinitions(),
      config: { autoConfirm: true },
      runtime,
      hooks: createHookExecutor({}),
      maxSteps: 5,
      wiredPipeline,
    });

    expect(result.finishReason).toBe("stop");
    const toolStep = result.steps.find((s) => s.type === "tool_call");
    expect(toolStep).toBeDefined();
    if (toolStep && toolStep.type === "tool_call") {
      expect(toolStep.toolCall?.name).toBe("use_skill");
      expect(toolStep.toolCall?.result).toContain("Error: Skill 'missing-skill' not found.");
      expect(toolStep.toolCall?.result).toContain("hello-ops");
    }
  });
});
