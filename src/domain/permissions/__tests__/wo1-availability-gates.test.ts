/**
 * US0 red gates (022-5-WO1 T005/T006): the edit_file section read must not
 * wedge at ANALYSIS time on a FIFO (a tag-minted path swapped to a FIFO
 * blocks the open pre-approval), and the permissions suite must exit clean —
 * today r9-1-behaviors trips 4 unhandled DurableApprovalStore rejections
 * from floating persist()/resolveRequest() promises.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, realpathSync, writeFileSync } from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSnapshotStore } from "../../../foundations/hashline/snapshot-store.js";
import { InMemoryArtifactStore } from "../../../capabilities/execution/in-memory-artifact-store.js";
import { analyzeEditFile } from "../../../capabilities/tools/analyzers.js";
import type { ToolAnalysisContext } from "../../../foundations/contracts/custom-tools.js";

describe("edit_file section read on a FIFO (022-5-WO1 T005)", () => {
  let dir: string;
  let ctx: ToolAnalysisContext;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "seepient-edit-fifo-")));
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

  it("returns a typed denial within the timeout when a tagged path became a FIFO", async () => {
    const file = join(dir, "sec.txt");
    writeFileSync(file, "one\ntwo\n");
    ctx.snapshotStore!.record(file, "one\ntwo\n");
    const tag = ctx.snapshotStore!.resolvePath(file)!.tag;

    // Swap the regular file for a FIFO at the same path.
    execSync(`rm ${JSON.stringify(file)} && mkfifo ${JSON.stringify(file)}`);

    const outcome = await Promise.race([
      analyzeEditFile({ patch: `[${file}#${tag}]\nINS.TAIL:\n+x` }, ctx).then(
        (a) => ({ kind: "resolved" as const, a }),
        (e: unknown) => ({ kind: "rejected" as const, e: e as Error }),
      ),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("section open never returned")), 3000)),
    ]);
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect(outcome.e.message).toMatch(/regular file|FIFO|not a regular/i);
    }
  });
});

describe("permissions suite exits clean (022-5-WO1 T006)", () => {
  it("r9-1-behaviors exits 0 with no unhandled errors in stderr", () => {
    const r = spawnSync("pnpm", ["vitest", "run", "src/domain/permissions/__tests__/r9-1-behaviors.test.ts"], {
      encoding: "utf8",
      timeout: 120_000,
    });
    const output = `${r.stdout ?? ""}\n${r.stderr ?? ""}`.replace(/\x1b\[[0-9;]*m/g, "");
    expect(r.status, `suite exited ${r.status}; output:\n${output.slice(-2000)}`).toBe(0);
    expect(output).not.toMatch(/unhandled error/i);
  }, 150_000);
});
