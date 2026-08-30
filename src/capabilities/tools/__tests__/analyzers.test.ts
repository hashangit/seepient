/**
 * Image-destination analyzer tests (spec 019 FR-011, T033, QS-1.6a).
 *
 * A file destination adds a filesystem-write effect and rides the broker
 * operation as `outputCommit` — analysis performs NO network I/O; the bytes
 * only exist after dispatch.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeGenerateImage, analyzeExecuteShellCommand, checkShellSyntax } from "../analyzers.js";
import { InMemoryArtifactStore } from "../../execution/in-memory-artifact-store.js";
import type { ToolAnalysisContext } from "../../../foundations/contracts/custom-tools.js";
import { createSnapshotStore } from "../../../foundations/hashline/snapshot-store.js";

describe("generate_image destination effects (spec 019 FR-011)", () => {
  let dir: string;
  let ctx: ToolAnalysisContext;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "seepient-img-dest-")));
    ctx = {
      principalId: "user",
      runId: "r1",
      toolCallId: "c1",
      workspace: { workspaceId: "ws", canonicalRoot: dir, policyVersion: 1, policyDigest: "d" },
      artifacts: new InMemoryArtifactStore(),
      modelProviderClass: "openai",
      snapshotStore: createSnapshotStore(),
    };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("destination present ⇒ filesystem-write effect + outputCommit on the broker operation", async () => {
    const dest = join(dir, "out.png");
    const action = await analyzeGenerateImage({ prompt: "a sunset", output_path: dest }, ctx);

    expect(action.operation.kind).toBe("broker");
    if (action.operation.kind !== "broker") return;
    const request = action.operation.request as { outputCommit?: { destination: { canonicalPath: string } } };
    expect(request.outputCommit).toBeDefined();
    expect(request.outputCommit?.destination.canonicalPath).toBe(dest);

    const writeEffect = action.effects.find((e) => e.kind === "filesystem-write");
    expect(writeEffect).toBeDefined();
    if (writeEffect && writeEffect.kind === "filesystem-write") {
      expect(writeEffect.targets[0].target.canonicalPath).toBe(dest);
    }
  });

  it("action digest is computed without any fetch (analysis stays pure)", async () => {
    const dest = join(dir, "pure.png");
    // Any network attempt during analysis fails the test: the bytes exist
    // only after dispatch.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => Promise.reject(new Error("NETWORK AT ANALYSIS"))) as typeof fetch;
    try {
      const action = await analyzeGenerateImage({ prompt: "offline", output_path: dest }, ctx);
      expect(action.actionDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(action.effects.some((e) => e.kind === "filesystem-write")).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("no destination ⇒ defaults to workspace root with filesystem-write effect + outputCommit", async () => {
    const action = await analyzeGenerateImage({ prompt: "just a prompt" }, ctx);
    expect(action.operation.kind).toBe("broker");
    if (action.operation.kind !== "broker") return;
    const request = action.operation.request as { outputCommit?: { destination: { canonicalPath: string } } };
    expect(request.outputCommit).toBeDefined();
    expect(request.outputCommit?.destination.canonicalPath).toContain(dir);
    expect(action.effects.some((e) => e.kind === "filesystem-write")).toBe(true);
  });
});

describe("execute_shell_command syntax validation (Fix 2)", () => {
  let dir: string;
  let ctx: ToolAnalysisContext;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "seepient-sh-test-")));
    ctx = {
      principalId: "user",
      runId: "r1",
      toolCallId: "c1",
      workspace: { workspaceId: "ws", canonicalRoot: dir, policyVersion: 1, policyDigest: "d" },
      artifacts: new InMemoryArtifactStore(),
      modelProviderClass: "openai",
      snapshotStore: createSnapshotStore(),
    };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("unbalanced quote command produces none-op action with SHELL_SYNTAX_INVALID and remediation hint", async () => {
    if (process.platform === "win32") return;
    const action = await analyzeExecuteShellCommand({ command: 'echo "unbalanced' }, ctx);

    expect(action.operation.kind).toBe("none");
    if (action.operation.kind === "none") {
      expect(action.operation.result.success).toBe(false);
      expect(action.operation.result.metadata?.code).toBe("SHELL_SYNTAX_INVALID");
      expect(action.operation.result.output).toContain("Shell syntax error:");
      expect(action.operation.result.output).toContain("Fix the quoting and retry: prefer single quotes around arguments containing spaces or special characters; ensure every opening quote is closed.");
    }
    expect(action.effects).toEqual([]);
    expect(action.risk).toBe("safe");
  });

  it("balanced quotes and multi-line commands prepare normal process operation", async () => {
    const command = 'echo "hello world" && echo \'single quotes\'\nls -la';
    const action = await analyzeExecuteShellCommand({ command }, ctx);

    expect(action.operation.kind).toBe("process");
    if (action.operation.kind === "process") {
      expect(action.operation.command.argv).toEqual([process.platform === "win32" ? "/c" : "-c", command]);
    }
    expect(action.effects.some((e) => e.kind === "process-exec")).toBe(true);
  });

  it("checkShellSyntax returns valid for valid commands and invalid for syntax errors", async () => {
    if (process.platform === "win32") return;
    const valid = await checkShellSyntax('echo "foo"');
    expect(valid.valid).toBe(true);

    const invalid = await checkShellSyntax('for i in 1 2 3; do echo $i');
    expect(invalid.valid).toBe(false);
    expect(invalid.error).toBeDefined();
  });

  it("checkShellSyntax fails open on non-string input or windows platform", async () => {
    const res = await checkShellSyntax(undefined as any);
    expect(res.valid).toBe(true);
  });
});
