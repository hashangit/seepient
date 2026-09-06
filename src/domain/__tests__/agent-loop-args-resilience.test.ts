import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, realpathSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runAgentLoop,
  parseToolArguments,
} from "../agent-loop.js";
import { createMockRuntime } from "./test-doubles.js";
import { getAllToolDefinitions } from "../tool-executor.js";
import { diskBackedFakeHelper } from "../../capabilities/execution/__tests__/helpers/commit-helper-fakes.js";

describe("Tool Argument Resilience & Contract Enforcement", () => {
  describe("parseToolArguments unit tests", () => {
    it("handles pre-parsed object arguments", () => {
      const res = parseToolArguments({ path: "/foo/bar.txt", content: "hello" });
      expect(res.success).toBe(true);
      expect(res.args).toEqual({ path: "/foo/bar.txt", content: "hello" });
    });

    it("parses valid JSON string", () => {
      const res = parseToolArguments('{"path": "/foo/bar.txt", "content": "hello"}');
      expect(res.success).toBe(true);
      expect(res.args).toEqual({ path: "/foo/bar.txt", content: "hello" });
    });

    it("handles null, undefined, or empty string as empty object", () => {
      expect(parseToolArguments(null).args).toEqual({});
      expect(parseToolArguments(undefined).args).toEqual({});
      expect(parseToolArguments("").args).toEqual({});
      expect(parseToolArguments("{}").args).toEqual({});
    });

    it("repairs literal unescaped newlines and tabs inside multiline strings", () => {
      const malformedWithLiteralNewlines =
        '{"path": "/foo/bar.md", "content": "# Title\nLine 2\n\tIndented line"}';
      expect(() => JSON.parse(malformedWithLiteralNewlines)).toThrow();

      const res = parseToolArguments(malformedWithLiteralNewlines);
      expect(res.success).toBe(true);
      expect(res.args.path).toBe("/foo/bar.md");
      expect(res.args.content).toBe("# Title\nLine 2\n\tIndented line");
    });

    it("repairs arguments wrapped in markdown code fences", () => {
      const fenced = '```json\n{"path": "/a.txt", "content": "hello"}\n```';
      const res = parseToolArguments(fenced);
      expect(res.success).toBe(true);
      expect(res.args.path).toBe("/a.txt");
    });

    it("returns descriptive error when JSON is completely truncated/invalid", () => {
      const truncated = '{"path": "/foo/bar.txt", "content": "# Cut off';
      const res = parseToolArguments(truncated);
      expect(res.success).toBe(false);
      expect(res.error).toBeDefined();
    });
  });

  describe("agent loop integration with malformed/resilient arguments", () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = realpathSync(mkdtempSync(join(tmpdir(), "seepient-resilience-test-")));
    });

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    it("successfully repairs and writes file when model emits literal unescaped newlines in content", async () => {
      const targetFile = join(tempDir, "analysis.md");
      const unescapedPayload =
        '{"path": "' + targetFile + '", "content": "# Architecture Analysis\n\n## Section 1\nContent with literal newlines"}';

      const runtime = createMockRuntime([
        {
          tool_calls: [
            {
              id: "call_repair_1",
              name: "write_file",
              arguments: unescapedPayload,
            },
          ],
        },
        {
          content: "File written successfully.",
        },
      ]);

      const steps: any[] = [];
      await runAgentLoop({
        runtime,
        model: "mock-model",
        messages: [{ id: "1", role: "user", content: "Write analysis", timestamp: Date.now() }],
        toolDefs: getAllToolDefinitions(),
        maxSteps: 5,
        cwd: tempDir,
        autoConfirm: true,
        commitHelper: diskBackedFakeHelper(),
        onStep: (step) => steps.push(step),
      });

      const toolStep = steps.find((s) => s.type === "tool_call");
      expect(toolStep).toBeDefined();
      expect(toolStep.toolCall.result).toContain("Successfully wrote to");
      expect(readFileSync(targetFile, "utf-8")).toContain("# Architecture Analysis\n\n## Section 1");
    });

    it("returns actionable Model Output Contract Violation when tool arguments cannot be parsed", async () => {
      const brokenPayload = '{"path": "/not/closed", "content": ';

      const runtime = createMockRuntime([
        {
          tool_calls: [
            {
              id: "call_broken_1",
              name: "write_file",
              arguments: brokenPayload,
            },
          ],
        },
        {
          content: "Understood the error.",
        },
      ]);

      const steps: any[] = [];
      await runAgentLoop({
        runtime,
        model: "mock-model",
        messages: [{ id: "1", role: "user", content: "Write broken file", timestamp: Date.now() }],
        toolDefs: getAllToolDefinitions(),
        maxSteps: 5,
        cwd: tempDir,
        autoConfirm: true,
        onStep: (step) => steps.push(step),
      });

      const toolStep = steps.find((s) => s.type === "tool_call");
      expect(toolStep).toBeDefined();
      expect(toolStep.toolCall.result).toContain("Error (Model Output Contract Violation)");
      expect(toolStep.toolCall.result).toContain("Failed to parse arguments for tool \"write_file\"");
      expect(toolStep.toolCall.result).toContain("Tool calls must strictly follow the JSON parameter schema contract");
      expect(toolStep.toolCall.result).not.toContain("TypeError");
      expect(toolStep.toolCall.result).not.toContain("Received undefined");
    });
  });
});
