import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, realpathSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeEditFile } from "../../../capabilities/tools/analyzers.js";
import { InMemoryArtifactStore } from "../../../capabilities/execution/in-memory-artifact-store.js";
import type { ToolAnalysisContext } from "../../../foundations/contracts/custom-tools.js";
import type { ApprovalBroker } from "../../../foundations/contracts/permission-policy.js";
import { runAgentLoop } from "../../agent-loop.js";
import { buildActionLifecycle } from "../action-lifecycle-factory.js";
import { buildLocalBoundary } from "../../../capabilities/execution/build-local-boundary.js";
import { createSnapshotStore, tagFor } from "../../../foundations/hashline/snapshot-store.js";
import { createHookExecutor } from "../../hooks.js";
import { createMockRuntime } from "../../__tests__/test-doubles.js";
import { getAllToolDefinitions, getAllToolModules } from "../../tool-executor.js";

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

describe("edit_file analyzer & pipeline end-to-end acceptance", () => {
  let dir: string;
  let artifacts: InMemoryArtifactStore;
  let ctx: ToolAnalysisContext;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "seepient-edit-e2e-")));
    artifacts = new InMemoryArtifactStore();
    ctx = {
      principalId: "user",
      runId: "r1",
      toolCallId: "c1",
      workspace: {
        workspaceId: "ws-test",
        canonicalRoot: dir,
        policyVersion: 1,
        policyDigest: "d-test",
      },
      artifacts,
      modelProviderClass: "openai",
    };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("analyzeEditFile unit behavior", () => {
    it("parses single [PATH#TAG] header and emits trusted-host op with filesystem-write and model-egress", async () => {
      const filePath = join(dir, "target.txt");
      writeFileSync(filePath, "initial line\n", "utf8");

      const action = await analyzeEditFile(
        { patch: `[target.txt#a1b2]\nINS.TAIL:\n+second line` },
        ctx,
      );

      expect(action.operation).toEqual({
        kind: "trusted-host",
        registrationId: "edit_file",
        toolName: "edit_file",
        args: { patch: `[target.txt#a1b2]\nINS.TAIL:\n+second line` },
      });

      const writeEffect = action.effects.find((e) => e.kind === "filesystem-write");
      expect(writeEffect).toBeDefined();
      if (writeEffect && writeEffect.kind === "filesystem-write") {
        expect(writeEffect.targets).toHaveLength(1);
        expect(writeEffect.targets[0].target.canonicalPath).toBe(filePath);
      }

      const egressEffect = action.effects.find((e) => e.kind === "model-egress");
      expect(egressEffect).toBeDefined();
      if (egressEffect && egressEffect.kind === "model-egress") {
        expect(egressEffect.sources).toContain(filePath);
      }
    });

    it("parses multiple [PATH#TAG] section headers and emits write effects for all targets", async () => {
      const file1 = join(dir, "a.txt");
      const file2 = join(dir, "b.txt");
      writeFileSync(file1, "file a\n", "utf8");
      writeFileSync(file2, "file b\n", "utf8");

      const multiPatch = `[a.txt#1111]\nINS.TAIL:\n+extra a\n[b.txt#2222]\nINS.TAIL:\n+extra b`;
      const action = await analyzeEditFile({ patch: multiPatch }, ctx);

      expect(action.operation.kind).toBe("trusted-host");
      const writeEffect = action.effects.find((e) => e.kind === "filesystem-write");
      expect(writeEffect).toBeDefined();
      if (writeEffect && writeEffect.kind === "filesystem-write") {
        expect(writeEffect.targets).toHaveLength(2);
        const paths = writeEffect.targets.map((t) => t.target.canonicalPath);
        expect(paths).toContain(file1);
        expect(paths).toContain(file2);
      }

      expect(action.display.canonicalTargets).toContain(file1);
      expect(action.display.canonicalTargets).toContain(file2);
    });

    it("throws structured error on garbage patch with no valid section headers", async () => {
      await expect(
        analyzeEditFile({ patch: "just some random text without headers" }, ctx),
      ).rejects.toThrow("Invalid patch: no valid [PATH#TAG] section headers found");
    });
  });

  describe("end-to-end execution through permission pipeline", () => {
    it("edits file correctly when valid hashline patch is processed through pipeline", async () => {
      const targetFile = join(dir, "code.txt");
      const initialContent = "line 1\nline 2\n";
      writeFileSync(targetFile, initialContent, "utf8");

      const store = createSnapshotStore();
      const tag = store.record(targetFile, initialContent);
      expect(tag).toBe(tagFor(targetFile, initialContent));

      const hostCallbacks = new Map<string, (args: unknown) => Promise<unknown>>();
      for (const mod of getAllToolModules()) {
        if (mod.handler) {
          hostCallbacks.set(mod.definition.function.name, (args) =>
            mod.handler!(args as any, { snapshotStore: store }),
          );
        }
      }

      const { boundary, artifacts: boundaryArtifacts } = await buildLocalBoundary({
        workspaceRoot: dir,
        hostCallbacks,
      });

      const wiredPipeline = await buildActionLifecycle({
        principalId: "user-test",
        runId: "run-e2e-edit",
        workspaceRoot: dir,
        approvalBroker: NOOP_BROKER,
        executionBoundary: boundary,
        artifacts: boundaryArtifacts,
        auditRoot: join(dir, "audit"),
        consentMode: "edit-enabled",
      });

      const patch = `[${targetFile}#${tag}]\nSWAP 1.=1:\n+line one replaced`;
      const runtime = createMockRuntime([
        {
          toolCalls: [
            {
              id: "tc_edit_1",
              name: "edit_file",
              args: { patch },
            },
          ],
        },
        {
          text: "File edit complete.",
        },
      ]);

      const result = await runAgentLoop({
        messages: [{ id: "m1", role: "user", content: "edit code.txt", timestamp: Date.now() }],
        systemPrompt: "You are a test agent.",
        toolDefs: getAllToolDefinitions(),
        config: { autoConfirm: true, snapshotStore: store },
        runtime,
        hooks: createHookExecutor({}),
        maxSteps: 5,
        wiredPipeline,
      });

      expect(result.finishReason).toBe("stop");
      const toolStep = result.steps.find((s) => s.type === "tool_call");
      expect(toolStep).toBeDefined();
      if (toolStep && toolStep.type === "tool_call" && toolStep.toolCall) {
        expect(toolStep.toolCall.name).toBe("edit_file");
        expect(toolStep.toolCall.result).toContain("Edited 1 file(s)");
      }

      const diskContent = readFileSync(targetFile, "utf8");
      expect(diskContent).toBe("line one replaced\nline 2\n");
    });

    it("fails garbage patch without touching disk", async () => {
      const targetFile = join(dir, "untouched.txt");
      const originalContent = "do not modify\n";
      writeFileSync(targetFile, originalContent, "utf8");

      const store = createSnapshotStore();
      const hostCallbacks = new Map<string, (args: unknown) => Promise<unknown>>();
      for (const mod of getAllToolModules()) {
        if (mod.handler) {
          hostCallbacks.set(mod.definition.function.name, (args) =>
            mod.handler!(args as any, { snapshotStore: store }),
          );
        }
      }

      const { boundary, artifacts: boundaryArtifacts } = await buildLocalBoundary({
        workspaceRoot: dir,
        hostCallbacks,
      });

      const wiredPipeline = await buildActionLifecycle({
        principalId: "user-test",
        runId: "run-e2e-edit-fail",
        workspaceRoot: dir,
        approvalBroker: NOOP_BROKER,
        executionBoundary: boundary,
        artifacts: boundaryArtifacts,
        auditRoot: join(dir, "audit"),
        consentMode: "edit-enabled",
      });

      const runtime = createMockRuntime([
        {
          toolCalls: [
            {
              id: "tc_edit_bad",
              name: "edit_file",
              args: { patch: "invalid patch without header" },
            },
          ],
        },
        {
          text: "Patch failed.",
        },
      ]);

      const result = await runAgentLoop({
        messages: [{ id: "m1", role: "user", content: "edit untouched.txt", timestamp: Date.now() }],
        systemPrompt: "You are a test agent.",
        toolDefs: getAllToolDefinitions(),
        config: { autoConfirm: true, snapshotStore: store },
        runtime,
        hooks: createHookExecutor({}),
        maxSteps: 5,
        wiredPipeline,
      });

      const diskContent = readFileSync(targetFile, "utf8");
      expect(diskContent).toBe(originalContent);
    });
  });
});
