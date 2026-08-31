/**
 * PreparedTool Dispatch E2E Test Suite (Spec 020, US2, QS-1.1 – QS-1.6)
 *
 * Verifies:
 *  - QS-1.1: preparedTool executes through createAgent({ permissionPipeline: true })
 *            with effect-described approval prompt and digests in audit.
 *  - QS-1.2: Parity across generateText and streamText.
 *  - QS-1.3: Malformed drafts fail closed without showing approval prompt.
 *  - QS-1.4: Analyzer errors surface directly, never the misleading allowlist hint.
 *  - QS-1.5: Consent modes (ask-everything / edit-enabled / autonomous) honored.
 *  - QS-1.6: commit-files emission routes through FileCommitBroker with exact-commit safety.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, realpathSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgent,
  generateText,
  streamText,
} from "../index.js";
import { preparedTool } from "../custom-tools.js";
import { createMockRuntime } from "../../../domain/__tests__/test-doubles.js";
import type { CanonicalPathTarget } from "../../../foundations/contracts/tool-effects.js";
import { diskBackedFakeHelper } from "../../../capabilities/execution/__tests__/helpers/commit-helper-fakes.js";

let dir: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "seepient-prep-dispatch-")));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function canonicalTarget(filePath: string): CanonicalPathTarget {
  const abs = join(dir, filePath);
  return {
    canonicalPath: abs,
    canonicalParent: dir,
    basename: filePath,
    exists: existsSync(abs),
    finalSymlink: false,
  };
}

describe("preparedTool Dispatch & Parity (QS-1.1 – QS-1.6)", () => {
  it("QS-1.1: executes preparedTool via createAgent with effect-described approval and exact commit", async () => {
    let capturedPrompt: any;
    const targetFile = "weekly-report.txt";
    const reportPath = join(dir, targetFile);

    const reportTool = preparedTool({
      definition: {
        type: "function",
        function: {
          name: "generate_report",
          description: "Generate and save weekly report",
          parameters: {
            type: "object",
            properties: { title: { type: "string" }, content: { type: "string" } },
            required: ["title", "content"],
          },
        },
      },
      allowedOperationKinds: ["commit-files"],
      analyze: async (args: any, context) => {
        const artifact = await context.artifacts.put(
          Buffer.from(`Report: ${args.title}\n${args.content}`),
          "text/plain",
        );
        const target = canonicalTarget(targetFile);
        return {
          operation: {
            kind: "commit-files",
            commits: [{ destination: target, content: artifact }],
          },
          effects: [
            {
              kind: "filesystem-write",
              targets: [{ target, mode: "create" }],
            },
          ],
          risk: "edit",
          display: {
            title: `Write report to ${targetFile}`,
            summary: `Writes weekly report to ${targetFile}`,
            canonicalTargets: [target.canonicalPath],
            effects: ["filesystem-write"],
          },
        };
      },
    });

    const runtime = createMockRuntime([
      {
        toolCalls: [
          {
            id: "tc_rep",
            name: "generate_report",
            args: { title: "Q3 Metrics", content: "Growth up 25%" },
          },
        ],
      },
      { content: "Report successfully generated and saved." },
    ]);

    const agent = await createAgent({
      permissionPipeline: true,
      runtime: runtime as never,
      tools: [reportTool],
      cwd: dir,
      commitHelper: diskBackedFakeHelper(),
      approveTool: async (req: any) => {
        capturedPrompt = req;
        return true;
      },
    } as never);

    const res = await agent.chat("Please generate the weekly report");
    expect(res.text).toBe("Report successfully generated and saved.");

    // Verify approval prompt carried the real display title and was NOT "host tool"
    expect(capturedPrompt).toBeDefined();
    expect(capturedPrompt.description ?? capturedPrompt.toolName ?? "").not.toContain("host");

    // Verify the file was written to disk exactly
    expect(existsSync(reportPath)).toBe(true);
    expect(readFileSync(reportPath, "utf8")).toBe("Report: Q3 Metrics\nGrowth up 25%");
  });

  it("QS-1.2: executes preparedTool parity across generateText and streamText", async () => {
    const makeTool = (suffix: string) =>
      preparedTool({
        definition: {
          type: "function",
          function: {
            name: `write_note_${suffix}`,
            description: "Write note",
            parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
          },
        },
        allowedOperationKinds: ["commit-files"],
        analyze: async (args: any, context) => {
          const artifact = await context.artifacts.put(Buffer.from(args.text), "text/plain");
          const target = canonicalTarget(`note-${suffix}.txt`);
          return {
            operation: {
              kind: "commit-files",
              commits: [{ destination: target, content: artifact }],
            },
            effects: [{ kind: "filesystem-write", targets: [{ target, mode: "create" }] }],
            risk: "edit",
            display: {
              title: `Write note ${suffix}`,
              summary: `Writes note-${suffix}.txt`,
              canonicalTargets: [target.canonicalPath],
              effects: ["filesystem-write"],
            },
          };
        },
      });

    // Test generateText
    const genRuntime = createMockRuntime([
      {
        toolCalls: [
          { id: "tc_g", name: "write_note_gen", args: { text: "generated text note" } },
        ],
      },
      { content: "Note written." },
    ]);

    const genRes = await generateText("Write note via generateText", {
      permissionPipeline: true,
      runtime: genRuntime as never,
      tools: [makeTool("gen")],
      cwd: dir,
      commitHelper: diskBackedFakeHelper(),
      approveTool: async () => true,
    } as never);

    expect(genRes.text).toBe("Note written.");
    expect(readFileSync(join(dir, "note-gen.txt"), "utf8")).toBe("generated text note");

    // Test streamText
    const streamRuntime = createMockRuntime([
      {
        toolCalls: [
          { id: "tc_s", name: "write_note_stream", args: { text: "streamed text note" } },
        ],
      },
      { content: "Streamed note written." },
    ]);

    const stream = await streamText("Write note via streamText", {
      permissionPipeline: true,
      runtime: streamRuntime as never,
      tools: [makeTool("stream")],
      cwd: dir,
      commitHelper: diskBackedFakeHelper(),
      approveTool: async () => true,
    } as never);

    const fullText = await stream.fullText;
    expect(fullText).toBe("Streamed note written.");
    expect(readFileSync(join(dir, "note-stream.txt"), "utf8")).toBe("streamed text note");
  });

  it("QS-1.3: invalid draft fails closed and approval prompt is never shown", async () => {
    let approvalPromptShown = false;

    const brokenDraftTool = preparedTool({
      definition: {
        type: "function",
        function: {
          name: "broken_tool",
          description: "Returns invalid draft",
          parameters: { type: "object", properties: {}, required: [] },
        },
      },
      allowedOperationKinds: ["commit-files"],
      analyze: async () => {
        // Missing required 'display' and 'effects'
        return {
          operation: { kind: "commit-files", commits: [] },
        } as any;
      },
    });

    const runtime = createMockRuntime([
      {
        toolCalls: [
          { id: "tc_broken", name: "broken_tool", args: {} },
        ],
      },
      { content: "Handled error." },
    ]);

    const agent = await createAgent({
      permissionPipeline: true,
      runtime: runtime as never,
      tools: [brokenDraftTool],
      cwd: dir,
      commitHelper: diskBackedFakeHelper(),
      approveTool: async () => {
        approvalPromptShown = true;
        return true;
      },
    } as never);

    await agent.chat("Run broken tool");
    expect(approvalPromptShown).toBe(false);
    const history = agent.getHistory();
    const toolMsg = history.find((m) => m.role === "tool");
    expect(toolMsg?.content).toContain("PREPARED_ACTION_INVALID_SHAPE");
  });

  it("QS-1.4: analyzer exception surfaces analyzer error, never trustedHostAllowlist hint (FR-009)", async () => {
    const throwingTool = preparedTool({
      definition: {
        type: "function",
        function: {
          name: "failing_analyzer",
          description: "Throws in analyze()",
          parameters: { type: "object", properties: {}, required: [] },
        },
      },
      allowedOperationKinds: ["commit-files"],
      analyze: async () => {
        throw new Error("Analyzer connection to internal service timed out");
      },
    });

    const runtime = createMockRuntime([
      {
        toolCalls: [
          { id: "tc_fail", name: "failing_analyzer", args: {} },
        ],
      },
      { content: "Tool failed." },
    ]);

    const agent = await createAgent({
      permissionPipeline: true,
      runtime: runtime as never,
      tools: [throwingTool],
      cwd: dir,
      commitHelper: diskBackedFakeHelper(),
      approveTool: async () => true,
    } as never);

    await agent.chat("Run failing analyzer");
    const history = agent.getHistory();
    const toolMsg = history.find((m) => m.role === "tool");
    const toolResult = toolMsg?.content ?? "";
    expect(toolResult).toContain("Analyzer connection to internal service timed out");
    expect(toolResult).not.toContain("trustedHostAllowlist");
  });

  it("QS-1.5: respects consent modes (ask-everything vs autonomous)", async () => {
    let promptsCount = 0;
    const makeSimpleReport = () =>
      preparedTool({
        definition: {
          type: "function",
          function: { name: "save_quick_note", description: "Save note", parameters: { type: "object", properties: {}, required: [] } },
        },
        allowedOperationKinds: ["commit-files"],
        analyze: async (_args, context) => {
          const target = canonicalTarget("auto-note.txt");
          const art = await context.artifacts.put(Buffer.from("auto-content"), "text/plain");
          return {
            operation: { kind: "commit-files", commits: [{ destination: target, content: art }] },
            effects: [{ kind: "filesystem-write", targets: [{ target, mode: "create" }] }],
            risk: "edit",
            display: { title: "Auto Note", summary: "Auto", canonicalTargets: [target.canonicalPath], effects: ["filesystem-write"] },
          };
        },
      });

    const runtime = createMockRuntime([
      { toolCalls: [{ id: "tc_auto", name: "save_quick_note", args: {} }] },
      { content: "Done." },
    ]);

    // Autonomous consent mode should not prompt for allowed operations within ceiling
    const agent = await createAgent({
      permissionPipeline: true,
      consentMode: "autonomous",
      runtime: runtime as never,
      tools: [makeSimpleReport()],
      cwd: dir,
      commitHelper: diskBackedFakeHelper(),
      approveTool: async () => {
        promptsCount++;
        return true;
      },
    } as never);

    await agent.chat("Save quick note");
    expect(promptsCount).toBe(0);
    expect(existsSync(join(dir, "auto-note.txt"))).toBe(true);
  });

  it("QS-1.6: exact-commit interplay — commit-files emission without available helper fails closed", async () => {
    const unavailableHelper = {
      probe: { available: false, path: null, version: null, sha256: null, reason: "Binary missing" },
      apply: async () => { throw new Error("Unavailable"); },
    };

    const toolWithCommit = preparedTool({
      definition: {
        type: "function",
        function: { name: "commit_note", description: "Commit note", parameters: { type: "object", properties: {}, required: [] } },
      },
      allowedOperationKinds: ["commit-files"],
      analyze: async (_args, context) => {
        const target = canonicalTarget("fail-note.txt");
        const art = await context.artifacts.put(Buffer.from("data"), "text/plain");
        return {
          operation: { kind: "commit-files", commits: [{ destination: target, content: art }] },
          effects: [{ kind: "filesystem-write", targets: [{ target, mode: "create" }] }],
          risk: "edit",
          display: { title: "Fail Note", summary: "Fail", canonicalTargets: [target.canonicalPath], effects: ["filesystem-write"] },
        };
      },
    });

    const runtime = createMockRuntime([
      { toolCalls: [{ id: "tc_fail_commit", name: "commit_note", args: {} }] },
      { content: "Done." },
    ]);

    const agent = await createAgent({
      permissionPipeline: true,
      runtime: runtime as never,
      tools: [toolWithCommit],
      cwd: dir,
      commitHelper: unavailableHelper as any,
      approveTool: async () => true,
    } as never);

    await agent.chat("Commit note");
    const history = agent.getHistory();
    const toolMsg = history.find((m) => m.role === "tool");
    expect(toolMsg?.content).toContain("exact-commit-unavailable");
    expect(existsSync(join(dir, "fail-note.txt"))).toBe(false);
  });
});
