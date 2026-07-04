import { describe, it, expect } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { runAgentLoop } from "../agent-loop.js";
import { createHookExecutor } from "../hooks.js";
import { registerTool } from "../tool-executor.js";
import type { LLMProvider, StreamDelta } from "../../providers/types.js";
import type { ToolDefinition } from "../../tools/interface.js";
import type { Message } from "../types.js";

/** Mock provider: yields `firstCall` deltas, then a bare finish on later calls
 *  so the loop terminates after one tool round. */
function provider(firstCall: StreamDelta[]): LLMProvider {
  let call = 0;
  return {
    async chat() {
      throw new Error("chat() must not be called in stream mode");
    },
    async *chatStream() {
      const deltas = call === 0 ? firstCall : [{ type: "finish" as const }];
      call++;
      for (const d of deltas) yield d;
    },
  };
}

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

    const result = await runAgentLoop({
      provider: provider([
        { type: "tool_call_begin", index: 0, id: "tc1", name: TOOL },
        { type: "tool_call_delta", index: 0, argumentsDelta: "{}" },
        { type: "finish", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, cost: 0 } },
      ]),
      model: "test",
      messages: [userMsg("run it")],
      toolDefs: [toolDef],
      maxSteps: 5,
      hooks: createHookExecutor(),
      stream: true,
    });

    // The tool_call step carries the metadata for adapters to render.
    const toolStep = result.steps.find((s) => s.type === "tool_call" && s.toolCall?.name === TOOL);
    expect(toolStep).toBeDefined();
    expect(toolStep?.metadata).toMatchObject({ path: "/secret", newContent: "NEW" });

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
      const args = JSON.stringify({ path: file, content: "from loop\nline2" });

      const result = await runAgentLoop({
        provider: provider([
          { type: "tool_call_begin", index: 0, id: "tc1", name: "write_file" },
          { type: "tool_call_delta", index: 0, argumentsDelta: args },
          { type: "finish", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, cost: 0 } },
        ]),
        model: "test",
        messages: [userMsg("write it")],
        toolDefs: [writeDef],
        maxSteps: 5,
        hooks: createHookExecutor(),
        stream: true,
      });

      // The real WriteFileTool ran via executeTool; its metadata reached the step.
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
