/**
 * Spec 022 — Agent Loop Registry Retargeting Unit Tests (T009).
 */
import { describe, it, expect } from "vitest";
import { runAgentLoop } from "../agent-loop.js";
import { ToolRegistry } from "../tool-executor.js";
import { createMockRuntime } from "./test-doubles.js";
import type { ToolModule } from "../../foundations/contracts/tool.js";

describe("Agent loop per-agent registry retargeting (T009)", () => {
  it("executes a custom host tool present in the passed toolRegistry", async () => {
    let executed = false;
    const customHostTool: ToolModule = {
      definition: {
        type: "function",
        function: {
          name: "scoped_host_tool",
          description: "Scoped host tool",
          parameters: { type: "object", properties: {}, required: [] },
        },
      },
      name: "scoped_host_tool",
      handler: async () => {
        executed = true;
        return { success: true, output: "custom output" };
      },
    };

    const registry = new ToolRegistry([customHostTool]);

    const runtime = createMockRuntime([
      {
        toolCalls: [
          {
            id: "call_1",
            name: "scoped_host_tool",
            arguments: "{}",
          },
        ],
      },
      { text: "Tool executed successfully" },
    ]);

    const result = await runAgentLoop({
      runtime,
      messages: [{ id: "m1", role: "user", content: "run tool", timestamp: Date.now() }],
      toolDefs: registry.definitions(),
      toolRegistry: registry,
      maxSteps: 3,
      autoConfirm: true,
    });

    expect(executed).toBe(true);
    expect(result.finishReason).toBe("stop");
  });

  it("fails closed with HOST_TOOL_NOT_REGISTERED when host tool is absent from registry", async () => {
    // Registry without the requested tool
    const registry = new ToolRegistry([]);

    const runtime = createMockRuntime([
      {
        toolCalls: [
          {
            id: "call_1",
            name: "unregistered_tool",
            arguments: "{}",
          },
        ],
      },
      { text: "Done" },
    ]);

    const result = await runAgentLoop({
      runtime,
      messages: [{ id: "m1", role: "user", content: "run tool", timestamp: Date.now() }],
      toolDefs: [
        {
          type: "function",
          function: {
            name: "unregistered_tool",
            description: "unregistered",
            parameters: { type: "object", properties: {}, required: [] },
          },
        },
      ],
      toolRegistry: registry,
      maxSteps: 3,
      autoConfirm: true,
    });

    const toolStep = result.steps.find((s) => s.type === "tool_call");
    expect(toolStep).toBeDefined();
    expect((toolStep as any)?.toolCall?.result).toMatch(/HOST_TOOL_NOT_REGISTERED|not registered|denied|unknown/i);

    const toolMsg = result.messages.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.content).toMatch(/HOST_TOOL_NOT_REGISTERED|not registered|denied|unknown/i);
  });
});
