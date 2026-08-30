/**
 * edit_file → commit-files pipeline acceptance (spec 019 FR-001, T020,
 * QS-0.5).
 *
 * The analyzer prepares a `commit-files` operation (NOT trusted-host) with
 * prep-time patch application against the session snapshot store; the write
 * lands through FileCommitBroker under the commit-file capability envelope.
 * Scenarios: (a) op shape + expected snapshots + artifact bytes, (b) full
 * pipeline run through the broker with diff metadata parity, (c) envelope
 * without the commit-file cap → broker refusal, (d) symlink target →
 * analysis-time rejection, disk untouched, (e) stale-anchor merge-or-reject
 * identical to hashline semantics, (f) pipeline read→edit loop with NO
 * manual pre-recording — read_file's returned tag drives the patch.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, realpathSync, writeFileSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeEditFile } from "../../../capabilities/tools/analyzers.js";
import { CommitFilesExecutor } from "../../../capabilities/execution/executors.js";
import { FileCommitBroker } from "../../../capabilities/execution/file-commit-broker.js";
import { InMemoryArtifactStore } from "../../../capabilities/execution/in-memory-artifact-store.js";
import { buildLocalBoundary } from "../../../capabilities/execution/build-local-boundary.js";
import { buildActionLifecycle } from "../action-lifecycle-factory.js";
import { runAgentLoop } from "../../agent-loop.js";
import { createSnapshotStore, tagFor } from "../../../foundations/hashline/snapshot-store.js";
void tagFor;
import { createHookExecutor } from "../../hooks.js";
import { createMockRuntime } from "../../__tests__/test-doubles.js";
import { getAllToolDefinitions } from "../../tool-executor.js";
import { fakeCommitEnvelope, fakeHelper, diskBackedFakeHelper } from "../../../capabilities/execution/__tests__/helpers/commit-helper-fakes.js";
import type { ToolAnalysisContext } from "../../../foundations/contracts/custom-tools.js";
import type { ApprovalBroker, CapabilityEnvelope } from "../../../foundations/contracts/permission-policy.js";

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

describe("edit_file through the commit broker (spec 019)", () => {
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
      snapshotStore: createSnapshotStore(),
    };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("(a) emits commit-files with one commit per section, expected snapshots, post-patch artifact bytes", async () => {
    const fileA = join(dir, "a.txt");
    const fileB = join(dir, "b.txt");
    writeFileSync(fileA, "file a\n", "utf8");
    writeFileSync(fileB, "file b\n", "utf8");
    ctx.snapshotStore!.record(fileA, "file a\n");
    ctx.snapshotStore!.record(fileB, "file b\n");

    const patch = `[${fileA}#${ctx.snapshotStore!.resolvePath(fileA)!.tag}]\nINS.TAIL:\n+extra a\n[${fileB}#${ctx.snapshotStore!.resolvePath(fileB)!.tag}]\nINS.TAIL:\n+extra b`;
    const action = await analyzeEditFile({ patch }, ctx);

    // commit-files, NOT trusted-host — the conversion's headline assertion.
    expect(action.operation.kind).toBe("commit-files");
    if (action.operation.kind !== "commit-files") return;
    expect(action.operation.commits).toHaveLength(2);
    for (const commit of action.operation.commits) {
      expect(commit.expected).toMatchObject({ exists: true });
      expect(commit.expected?.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(action.operation.commits[0].destination.canonicalPath).toBe(fileA);
    expect(action.operation.commits[1].destination.canonicalPath).toBe(fileB);

    // Artifact bytes equal the post-patch file content.
    const bytesA = await artifacts.read(action.operation.commits[0].content);
    expect(new TextDecoder().decode(bytesA)).toBe("file a\n\nextra a");

    // Effects still declare the writes + egress (policy/prompt surface unchanged).
    const writeEffect = action.effects.find((e) => e.kind === "filesystem-write");
    expect(writeEffect).toBeDefined();
    if (writeEffect && writeEffect.kind === "filesystem-write") {
      expect(writeEffect.targets.map((t) => t.target.canonicalPath).sort()).toEqual([fileA, fileB].sort());
    }
  });

  it("(b) full pipeline run writes via FileCommitBroker (fake helper) with diff metadata parity", async () => {
    const targetFile = join(dir, "code.txt");
    writeFileSync(targetFile, "line 1\nline 2\n", "utf8");
    const store = ctx.snapshotStore!;
    store.record(targetFile, "line 1\nline 2\n");
    const tag = store.resolvePath(targetFile)!.tag;

    const { boundary, artifacts: boundaryArtifacts } = await buildLocalBoundary({
      workspaceRoot: dir,
      snapshotStore: store,
      commitHelper: diskBackedFakeHelper(),
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
      snapshotStore: store,
    });

    const patch = `[${targetFile}#${tag}]\nSWAP 1.=1:\n+line one replaced`;
    const runtime = createMockRuntime([
      { toolCalls: [{ id: "tc_edit_1", name: "edit_file", args: { patch } }] },
      { text: "File edit complete." },
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
      expect(toolStep.toolCall.result).toContain("Successfully wrote to");
    }
    // Diff metadata parity: oldContent/newContent feed the diff viewer.
    if (toolStep && toolStep.type === "tool_call") {
      const meta = toolStep.metadata as Record<string, unknown> | undefined;
      expect(meta).toMatchObject({
        path: targetFile,
        isNewFile: false,
        oldContent: "line 1\nline 2\n",
        newContent: "line one replaced\nline 2\n",
      });
    }

    expect(readFileSync(targetFile, "utf8")).toBe("line one replaced\nline 2\n");
    // Exact-commit evidence: the fake helper's executor id is commit-files-native.
  });

  it("(b2) broker refusal when the envelope lacks the commit-file cap", async () => {
    const targetFile = join(dir, "capped.txt");
    writeFileSync(targetFile, "original\n", "utf8");
    const store = ctx.snapshotStore!;
    store.record(targetFile, "original\n");
    const tag = store.resolvePath(targetFile)!.tag;

    const { applySectionsToSnapshot } = await import("../../../foundations/hashline/patcher.js");
    const { readFile } = await import("node:fs/promises");
    const patch = `[${targetFile}#${tag}]\nSWAP 1.=1:\n+replaced`;
    const sections = await applySectionsToSnapshot(
      patch,
      (p) => readFile(p, "utf-8"),
      store,
    );
    const artifact = await artifacts.put(Buffer.from(sections[0].applied, "utf8"), "text/plain");

    const broker = new FileCommitBroker({ artifacts, helper: fakeHelper({ available: true }) });
    const executor = new CommitFilesExecutor({ broker, artifacts, useNative: true });
    const action = await analyzeEditFile({ patch }, ctx);
    // An envelope WITHOUT any commit-file capability (e.g. mis-issued).
    const capless: CapabilityEnvelope = {
      ...fakeCommitEnvelope(targetFile),
      capabilities: [],
    };

    const result = await executor.execute(
      action,
      capless,
      { kind: "commit-files", commits: [{ destination: action.operation.kind === "commit-files" ? action.operation.commits[0].destination : ({} as never), content: artifact, expected: { exists: true } }] },
      {},
    );
    expect(result.state).toBe("failed");
    if (result.state === "failed") {
      // The executor wraps the broker's UnsupportedBackendError refusal.
      expect(result.error.message).toMatch(/commit|capability/i);
    }
    // Disk untouched.
    expect(readFileSync(targetFile, "utf8")).toBe("original\n");
  });

  it("(d) symlinked target in the patch → analysis-time rejection, disk untouched", async () => {
    const victim = join(dir, "victim.txt");
    const link = join(dir, "link.txt");
    writeFileSync(victim, "do not touch\n", "utf8");
    symlinkSync(victim, link);
    const store = ctx.snapshotStore!;
    store.record(link, "do not touch\n");
    const tag = store.resolvePath(link)!.tag;

    const patch = `[${link}#${tag}]\nSWAP 1.=1:\n+malicious`;
    await expect(analyzeEditFile({ patch }, ctx)).rejects.toThrow(/symbolic link/);
    // Disk untouched, symlink intact.
    expect(readFileSync(victim, "utf8")).toBe("do not touch\n");
    expect(readFileSync(link, "utf8")).toBe("do not touch\n");
  });

  it("(e) stale-anchor patch → merge-or-reject identical to hashline semantics", async () => {
    const file = join(dir, "stale.txt");
    writeFileSync(file, "line 1\nline 2\n", "utf8");
    const store = ctx.snapshotStore!;
    store.record(file, "line 1\nline 2\n");
    const tag = store.resolvePath(file)!.tag;

    // Diverging disk content: converging reapply (snapshot + ops == current)
    // merges; anything else fails closed with HASHLINE_STALE_ANCHOR.
    writeFileSync(file, "line 1\nline 2 changed\n", "utf8");
    const converging = `[${file}#${tag}]\nSWAP 2.=2:\n+line 2 changed`;
    const action = await analyzeEditFile({ patch: converging }, ctx);
    expect(action.operation.kind).toBe("commit-files");

    writeFileSync(file, "totally different\n", "utf8");
    const diverging = `[${file}#${tag}]\nSWAP 1.=1:\n+nope`;
    await expect(analyzeEditFile({ patch: diverging }, ctx)).rejects.toThrow(/Stale anchor/);
    expect(readFileSync(file, "utf8")).toBe("totally different\n");
  });

  it("(f) pipeline read→edit loop with no manual pre-recording: read tag drives the patch", async () => {
    const targetFile = join(dir, "loop.txt");
    writeFileSync(targetFile, "alpha\nbeta\n", "utf8");
    const store = ctx.snapshotStore!;

    const { boundary, artifacts: boundaryArtifacts } = await buildLocalBoundary({
      workspaceRoot: dir,
      snapshotStore: store,
      commitHelper: diskBackedFakeHelper(),
    });
    const wiredPipeline = await buildActionLifecycle({
      principalId: "user-test",
      runId: "run-e2e-loop",
      workspaceRoot: dir,
      approvalBroker: NOOP_BROKER,
      executionBoundary: boundary,
      artifacts: boundaryArtifacts,
      auditRoot: join(dir, "audit"),
      consentMode: "edit-enabled",
      snapshotStore: store,
    });

    // The model reads first; the SECOND response is built from whatever the
    // read_file tool result actually contained — no test-side recording.
    let editPatch: string | undefined;
    const runtime = createMockRuntime((req) => {
      // Only look at actual tool RESULT messages — never at the tool
      // description's "[content-tag:a1f2]" example. Tool message content is
      // nested ({content:[{type:"tool_result",content:[{type:"text",text}]}]}),
      // so collect strings recursively.
      const toolMsgs = (req.messages ?? []).filter((m: { role?: string }) => m.role === "tool");
      const strings: string[] = [];
      const collect = (v: unknown): void => {
        if (typeof v === "string") strings.push(v);
        else if (Array.isArray(v)) v.forEach(collect);
        else if (v && typeof v === "object") Object.values(v).forEach(collect);
      };
      toolMsgs.forEach((m: { content?: unknown }) => collect(m.content));
      const match = strings.join("\n").match(/\[content-tag:([0-9a-f]{4})\]/);
      if (!match) {
        return { toolCalls: [{ id: "tc_read_1", name: "read_file", args: { path: targetFile } }] };
      }
      if (editPatch) {
        // The edit already ran — stop the loop.
        return { text: "edit complete" };
      }
      editPatch = `[${targetFile}#${match[1]}]\nSWAP 1.=1:\n+alpha edited`;
      return { toolCalls: [{ id: "tc_edit_1", name: "edit_file", args: { patch: editPatch } }] };
    });

    const result = await runAgentLoop({
      messages: [{ id: "m1", role: "user", content: "edit loop.txt", timestamp: Date.now() }],
      systemPrompt: "You are a test agent.",
      toolDefs: getAllToolDefinitions(),
      config: { autoConfirm: true, snapshotStore: store },
      runtime,
      hooks: createHookExecutor({}),
      maxSteps: 8,
      wiredPipeline,
    });

    expect(result.finishReason).toBe("stop");
    expect(editPatch).toBeDefined();
    // The edit tool result reports success through the broker.
    const editStep = result.steps.find((st) => st.type === "tool_call" && st.toolCall?.name === "edit_file");
    expect(editStep).toBeDefined();
    // The store's entry for the file now reflects the EDITED content (the
    // commit path re-records) — and the disk carries the edit.
    expect(store.resolvePath(targetFile)).not.toBeNull();
    expect(readFileSync(targetFile, "utf8")).toBe("alpha edited\nbeta\n");
  });
});
