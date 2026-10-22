/**
 * 029 S13 suspension seam (T025, D9) — a governed tool raising a durable
 * pause ends the turn: no model-visible tool result, no further provider
 * call, finish state distinct from stop/error/aborted/max_steps. Both loop
 * entry paths (middleware-wrapped and raw) suspend identically.
 */
import { describe, expect, it } from "vitest";
import { registerFullComposition } from "../__tests__/full-composition.js";
registerFullComposition(); // full-package composition (built-ins + analyzers + boundary)
import { runAgentLoop } from "../agent-loop.js";
import type { AgentLoopResult, AgentSuspension } from "../agent-loop.js";
import type { Middleware as PipelineMiddleware, PipelineContext } from "../../foundations/contracts/middleware.js";
import { ToolSuspendedError } from "../../foundations/errors.js";
import { ToolRegistry } from "../tool-executor.js";
import { createMockRuntime } from "./test-doubles.js";
import type { ToolModule } from "../../foundations/contracts/tool.js";

function suspendingTool(): ToolModule {
  return {
    definition: {
      type: "function",
      function: {
        name: "governed_pause_tool",
        description: "Requires a durable approval pause",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    name: "governed_pause_tool",
    handler: async () => {
      throw new ToolSuspendedError("permission", "pause-token-1");
    },
  };
}

/** Responses: first asks for the tool; the second MUST never be requested. */
function mockRuntime() {
  return createMockRuntime([
    {
      toolCalls: [{ id: "call_1", name: "governed_pause_tool", arguments: "{}" }],
    },
    { text: "SHOULD NEVER BE REQUESTED" },
  ]);
}

async function expectSuspended(result: AgentLoopResult): Promise<void> {
  expect(result.finishReason).toBe("suspended");
  expect(result.suspension).toEqual({
    toolCallId: "call_1",
    toolName: "governed_pause_tool",
    pauseClass: "permission",
    pauseToken: "pause-token-1",
    auditBinding: {
      actionId: expect.any(String),
      actionDigest: expect.any(String),
      principalId: expect.any(String),
      runId: expect.any(String),
    },
  });
  // No model-visible tool result for the suspended call.
  const toolMessages = result.messages.filter((m) => m.role === "tool");
  expect(toolMessages).toEqual([]);
  // No step record presents the suspension as a completed tool call.
  expect(result.steps.some((s) => s.type === "tool_call" && s.toolCall?.name === "governed_pause_tool")).toBe(false);
  // The second provider response was never requested — no further provider call.
  const flat = JSON.stringify(result.messages);
  expect(flat).not.toContain("SHOULD NEVER BE REQUESTED");
}

describe("029 S13 suspension seam (T025)", () => {
  it("raw path: a governed pause suspends the turn (executeLoop via runAgentLoop, no middleware)", async () => {
    const runtime = mockRuntime();
    const registry = new ToolRegistry([suspendingTool()]);
    const result = await runAgentLoop({
      runtime,
      messages: [{ id: "m1", role: "user", content: "do the thing", timestamp: Date.now() }],
      toolDefs: registry.definitions(),
      toolRegistry: registry,
      maxSteps: 4,
      autoConfirm: true,
    });
    await expectSuspended(result);
  });

  it("middleware-wrapped path: the suspension passes the middleware result copy unchanged", async () => {
    const runtime = mockRuntime();
    const registry = new ToolRegistry([suspendingTool()]);
    // A middleware that observes the result but must not reinterpret the
    // suspension (the v0.8.1 result-copy class of bug).
    const seen: Array<AgentLoopResult["finishReason"]> = [];
    const observer: PipelineMiddleware = async (_ctx: PipelineContext, next) => {
      await next();
      seen.push((_ctx.result as AgentLoopResult).finishReason);
    };
    const result = await runAgentLoop({
      runtime,
      messages: [{ id: "m1", role: "user", content: "do the thing", timestamp: Date.now() }],
      toolDefs: registry.definitions(),
      toolRegistry: registry,
      maxSteps: 4,
      autoConfirm: true,
      middleware: [observer],
    });
    await expectSuspended(result);
    expect(seen).toEqual(["suspended"]);
  });

  it("fires the onSuspension propagation hook exactly once (T039 consumer)", async () => {
    const runtime = mockRuntime();
    const registry = new ToolRegistry([suspendingTool()]);
    const fired: Array<{ toolCallId: string; pauseToken: string }> = [];
    const result = await runAgentLoop({
      runtime,
      messages: [{ id: "m1", role: "user", content: "do the thing", timestamp: Date.now() }],
      toolDefs: registry.definitions(),
      toolRegistry: registry,
      maxSteps: 4,
      autoConfirm: true,
      onSuspension: (s) => {
        fired.push({ toolCallId: s.toolCallId, pauseToken: s.pauseToken });
      },
    });
    expect(result.finishReason).toBe("suspended");
    expect(fired).toEqual([{ toolCallId: "call_1", pauseToken: "pause-token-1" }]);
  });
});
