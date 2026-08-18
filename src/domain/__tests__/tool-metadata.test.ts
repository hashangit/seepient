import { describe, it, expect } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { runAgentLoop } from "../agent-loop.js";
import { createHookExecutor } from "../hooks.js";
import { registerTool } from "../tool-executor.js";
import type { ToolDefinition } from "../../foundations/contracts/tool.js";
import type { Message } from "../../foundations/types.js";
import { createMockRuntime } from "./test-doubles.js";

const userMsg = (content: string): Message => ({ id: "u1", role: "user", content, timestamp: 0 });

const TOOL = "metadata_probe_t051";
const toolDef: ToolDefinition = {
  type: "function",
  function: {
    name: TOOL,
    description: "probe",
    parameters: { type: "object", properties: {}, required: [] },
  },
};

describe("tool-result metadata channel", () => {
  it("attaches metadata to the step but keeps it out of message history", async () => {
    // Register a tool that returns structured metadata (as write_file does).
    registerTool({
      name: "Metadata Probe",
      risk: "safe",
      definition: toolDef,
      handler: async () => ({
        output: "wrote 3 lines",
        success: true,
        metadata: { path: "/secret", oldContent: "OLD", newContent: "NEW" },
      }),
    });

    const mockRuntime = createMockRuntime([
      {
        toolCalls: [
          {
            id: "tc1",
            name: TOOL,
            args: {},
          },
        ],
      },
      {
        text: "Done",
      },
    ]);

    const result = await runAgentLoop({
      runtime: mockRuntime,
      model: "test",
      messages: [userMsg("run it")],
      toolDefs: [toolDef],
      maxSteps: 5,
      hooks: createHookExecutor(),
      autoConfirm: true,
    });

    // The tool_call step carries the metadata for adapters to render.
    const toolStep = result.steps.find((s) => s.type === "tool_call" && s.toolCall?.name === TOOL);
    expect(toolStep).toBeDefined();

    // The tool-result message sent back to the provider contains ONLY the
    // output string — never the metadata (no LLM context pollution).
    const toolMsg = result.messages.find((m) => m.role === "tool");
    expect(toolMsg?.content).toBe("wrote 3 lines");
    expect(toolMsg?.content).not.toContain("/secret");
    expect(toolMsg?.content).not.toContain("OLD");
  });
});

describe("write_file through the agent loop", () => {
  it("attaches FileWriteMetadata to the step and writes the file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "seepient-loop-"));
    const file = path.join(dir, "loop-out.txt");
    try {
      const writeDef: ToolDefinition = {
        type: "function",
        function: {
          name: "write_file",
          description: "write",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string" },
              content: { type: "string" },
            },
            required: ["path", "content"],
          },
        },
      };
      const args = { path: file, content: "from loop\nline2" };
      const mockRuntime = createMockRuntime([
        {
          toolCalls: [
            {
              id: "tc1",
              name: "write_file",
              args,
            },
          ],
        },
        {
          text: "Done",
        },
      ]);
      const result = await runAgentLoop({
        runtime: mockRuntime,
        model: "test",
        messages: [userMsg("write it")],
        toolDefs: [writeDef],
        cwd: dir,
        maxSteps: 5,
        hooks: createHookExecutor(),
        autoConfirm: true,
      });
      const step = result.steps.find((s) => s.type === "tool_call" && s.toolCall?.name === "write_file");
      expect(step).toBeDefined();
      expect(step?.metadata).toMatchObject({ path: file, isNewFile: true, newContent: "from loop\nline2" });

      // Tool message still carries only the human-readable output.
      const toolMsg = result.messages.find((m) => m.role === "tool");
      expect(toolMsg?.content).toMatch(/Successfully wrote to /);
      expect(toolMsg?.content).not.toContain("from loop");

      await expect(fs.readFile(file, "utf-8")).resolves.toBe("from loop\nline2");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
