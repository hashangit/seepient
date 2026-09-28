/**
 * edit_file section-read ceiling (spec 022-5, FR-003).
 *
 * The prepare-time section read is a real read: it must clear the workspace
 * ceiling like every other model-influenced read, and an outside-ceiling
 * target must produce an indistinguishable denial whether it exists or is
 * dangling (no existence/hash oracle for host paths).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSnapshotStore } from "../../../foundations/hashline/snapshot-store.js";
import { InMemoryArtifactStore } from "../../../capabilities/execution/in-memory-artifact-store.js";
import { analyzeEditFile } from "../../../capabilities/tools/analyzers.js";
import type { ToolAnalysisContext } from "../../../foundations/contracts/custom-tools.js";

describe("edit_file section-read ceiling (022-5 FR-003)", () => {
  let dir: string;
  let ctx: ToolAnalysisContext;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "seepient-edit-ceiling-")));
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

  it("reads an in-workspace section and prepares the commit", async () => {
    const file = join(dir, "a.txt");
    writeFileSync(file, "one\ntwo\n");
    ctx.snapshotStore!.record(file, "one\ntwo\n");
    const tag = ctx.snapshotStore!.resolvePath(file)!.tag;
    const action = await analyzeEditFile({ patch: `[${file}#${tag}]\nINS.TAIL:\n+three` }, ctx);
    expect(action.operation.kind).toBe("commit-files");
  });

  it("denies an outside-ceiling section target without an existence differential", async () => {
    const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), "seepient-host-")));
    try {
      const existing = join(outsideDir, "host.txt");
      writeFileSync(existing, "host secret bytes");
      const dangling = join(outsideDir, "missing.txt");
      // Simulate the legitimate route by which a host path enters the store:
      // it was read while inside the ceiling (or reached via a symlink whose
      // realpath was recorded). The section header then references it.
      ctx.snapshotStore!.record(existing, "prior read\n");
      ctx.snapshotStore!.record(dangling, "prior read\n");
      const tagExisting = ctx.snapshotStore!.resolvePath(existing)!.tag;
      const tagDangling = ctx.snapshotStore!.resolvePath(dangling)!.tag;
      const patchExisting = `[${existing}#${tagExisting}]\nINS.TAIL:\n+x`;
      const patchDangling = `[${dangling}#${tagDangling}]\nINS.TAIL:\n+x`;

      const errExisting = await analyzeEditFile({ patch: patchExisting }, ctx).then(
        () => null,
        (e: unknown) => e as Error,
      );
      const errDangling = await analyzeEditFile({ patch: patchDangling }, ctx).then(
        () => null,
        (e: unknown) => e as Error,
      );

      // Both must be denied (never read), with the same denial class —
      // existence must not change the outcome's shape.
      expect(errExisting).not.toBeNull();
      expect(errDangling).not.toBeNull();
      expect((errExisting as Error).message).toMatch(/workspace/i);
      expect((errDangling as Error).message).toMatch(/workspace/i);
      expect((errExisting as Error).message).not.toMatch(/host secret bytes/);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("does not leak host-path bytes or hashes through a success path for outside targets", async () => {
    const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), "seepient-host2-")));
    try {
      const existing = join(outsideDir, "host2.txt");
      writeFileSync(existing, "OUTSIDE-CONTENT-MARKER");
      ctx.snapshotStore!.record(existing, "prior read\n");
      const tag = ctx.snapshotStore!.resolvePath(existing)!.tag;
      // A resolved action would mean the analyzer read outside bytes and
      // prepared commits from them — that is the oracle this FR closes.
      const outcome = await analyzeEditFile({ patch: `[${existing}#${tag}]\nINS.TAIL:\n+x` }, ctx).then(
        (a) => ({ resolved: true as const, a }),
        (e: unknown) => ({ resolved: false as const, e: e as Error }),
      );
      expect(outcome.resolved).toBe(false);
      if (!outcome.resolved) {
        expect(outcome.e.message).not.toContain("OUTSIDE-CONTENT-MARKER");
      }
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});
