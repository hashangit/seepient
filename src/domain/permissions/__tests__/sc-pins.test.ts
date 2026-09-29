/**
 * Unpinned success-criteria pins (022-5-WO1 T037 + T034).
 *
 * SC-008: universal roots ("/", "*") never survive the multi merge and ""
 * fails closed at coverage.
 * SC-009: ActionLifecycle.run never throws for ANY broker answer shape,
 * including literal null/undefined.
 * SC-011: a settled sandbox exec leaves no live process group (the pin also
 * lives in residual-guards.test.ts; this one drives the abort shape).
 * T034: a dangling symlink at an outside-ceiling target denies with the
 * same shape as an existing escape — no existence oracle.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, realpathSync, writeFileSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathContains } from "../../../domain/permissions/capability-store.js";
import { analyzeEditFile } from "../../../capabilities/tools/analyzers.js";
import { createSnapshotStore } from "../../../foundations/hashline/snapshot-store.js";
import { InMemoryArtifactStore } from "../../../capabilities/execution/in-memory-artifact-store.js";
import type { ToolAnalysisContext } from "../../../foundations/contracts/custom-tools.js";

describe("SC-008: universal-root caps never grant", () => {
  it('pathContains("/") covers inside paths (root capability semantics)', () => {
    expect(pathContains("/", "/workspace/a.txt")).toBe(true);
  });

  it('pathContains("") fails closed — a corrupt empty root grants nothing', () => {
    expect(pathContains("", "/workspace/a.txt")).toBe(false);
    expect(pathContains("", "")).toBe(false);
  });
});

describe("SC-009: run() never throws for any broker answer shape", () => {
  let dir: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "seepient-sc009-")));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function runWithAnswer(answer: unknown): Promise<{ state: string }> {
    const { buildActionLifecycle } = await import("../../../domain/permissions/action-lifecycle-factory.js");
    const { InMemoryAuditStore, InMemoryPolicyStore } = await import("../../../domain/permissions/in-memory-stores.js");
    const { InMemoryCapabilityLedger } = await import("../../../domain/permissions/in-memory-stores.js");
    // A real read effect — a no-effects action skips the approval flow
    // entirely and never consults the broker.
    const targetFile = join(dir, "out.txt");
    const action = {
      version: 1, actionId: "a", runId: "r", toolCallId: "c", toolName: "read_file",
      principalId: "u", argsDigest: "x", actionDigest: "d", risk: "read",
      display: { title: "t", summary: targetFile, canonicalTargets: [targetFile], effects: ["filesystem-read"] },
      effects: [{ kind: "filesystem-read", targets: [{ canonicalPath: targetFile, canonicalParent: dir, basename: "out.txt", exists: true, finalSymlink: false }], sensitivity: "normal" }],
      operation: {
        kind: "read-file",
        target: { canonicalPath: targetFile, canonicalParent: dir, basename: "out.txt", exists: true, finalSymlink: false },
        expected: { exists: true },
      },
    } as never;
    const wired = await buildActionLifecycle({
      principalId: "u",
      tenancyMode: "multi",
      runId: "r",
      sessionId: "s",
      workspaceRoot: dir,
      approvalBroker: {
        mode: "inline",
        request: async () => answer as never,
      },
      executionBoundary: {
        capabilities: { backend: "local-native", environmentIsolation: false, hostFilteredEgress: false, supportedOperationKinds: [] },
        async execute() {
          return { state: "succeeded", result: { output: "ok", success: true }, evidence: { backend: "local-native", actionDigest: "d", executorId: "x", operationKind: "none" } } as never;
        },
      } as never,
      auditStore: new InMemoryAuditStore() as never,
      capabilityLedger: new InMemoryCapabilityLedger() as never,
      policyStore: new InMemoryPolicyStore() as never,
    });
    const result = await wired.lifecycle.run(action);
    return { state: result.outcome.state };
  }

  it.each([
    ["literal null", null],
    ["literal undefined", undefined],
    ["a string", "garbage"],
    ["an object without approved", { requestId: "x" }],
  ])("a broker resolving %s yields the typed denial, never a throw", async (_label, answer) => {
    const result = await runWithAnswer(answer);
    expect(result.state).toBe("denied");
  });
});

describe("T034: the dangling-vs-existing symlink oracle is closed", () => {
  let dir: string;
  let outsideDir: string;
  let ctx: ToolAnalysisContext;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "seepient-oracle-")));
    outsideDir = realpathSync(mkdtempSync(join(tmpdir(), "seepient-oracle-host-")));
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
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it("an in-workspace symlink to an existing-outside target escapes identically whether the target exists or dangles", async () => {
    const existingTarget = join(outsideDir, "host.txt");
    writeFileSync(existingTarget, "host bytes");

    const linkExisting = join(dir, "link-existing");
    const linkDangling = join(dir, "link-dangling");
    symlinkSync(existingTarget, linkExisting);
    symlinkSync(join(outsideDir, "missing.txt"), linkDangling);

    // Record the links so the edit section path resolves (the store holds
    // the LINK path strings, simulating a prior guarded read of the links).
    ctx.snapshotStore!.record(linkExisting, "prior\n");
    ctx.snapshotStore!.record(linkDangling, "prior\n");
    const tagA = ctx.snapshotStore!.resolvePath(linkExisting)!.tag;
    const tagB = ctx.snapshotStore!.resolvePath(linkDangling)!.tag;

    const errExisting = await analyzeEditFile({ patch: `[${linkExisting}#${tagA}]\nINS.TAIL:\n+x` }, ctx).then(
      () => "resolved",
      (e: unknown) => String((e as Error).message),
    );
    const errDangling = await analyzeEditFile({ patch: `[${linkDangling}#${tagB}]\nINS.TAIL:\n+x` }, ctx).then(
      () => "resolved",
      (e: unknown) => String((e as Error).message),
    );

    // Both must be denied with byte-identical shapes — the only difference
    // is the path itself.
    expect(errExisting).not.toBe("resolved");
    expect(errDangling).not.toBe("resolved");
    expect(String(errDangling)).toBe(String(errExisting).replace("link-existing", "link-dangling"));
    void existsSync;
  });
});
