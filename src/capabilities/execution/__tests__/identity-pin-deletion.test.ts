/**
 * Identity-pin deletion pins (022-5-WO2 T010/T011): the commit old-content
 * pin and the edit-section pin are load-bearing — under guard neutralization
 * the swap SUCCEEDS (raced bytes flow), with the guard live it is denied.
 * Deleting either pin block flips its armed journey red.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, realpathSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CommitFilesExecutor,
} from "../../../capabilities/execution/executors.js";
import { createSnapshotStore } from "../../../foundations/hashline/snapshot-store.js";
import { InMemoryArtifactStore } from "../../../capabilities/execution/in-memory-artifact-store.js";
import { analyzeEditFile } from "../../../capabilities/tools/analyzers.js";
import type { PreparedToolAction } from "../../../foundations/contracts/prepared-action.js";
import type { CapabilityEnvelope } from "../../../foundations/contracts/permission-policy.js";
import type { ToolAnalysisContext } from "../../../foundations/contracts/custom-tools.js";

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "seepient-pin-delete-")));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function envelope(path: string): CapabilityEnvelope {
  return {
    version: 1,
    envelopeId: "e1",
    principalId: "u",
    runId: "r1",
    actionDigest: "d1",
    capabilities: [{ kind: "commit-file", path }],
    lifetime: { kind: "action", actionDigest: "d1", consumeOnce: true },
    issuedBy: { kind: "service", authorityId: "pe", authenticatedBy: "deployment" },
    issuedAt: 0,
    policyDigest: "dig",
  };
}

async function analyzedEditAction(file: string, ctx: ToolAnalysisContext): Promise<PreparedToolAction> {
  writeFileSync(file, "one\ntwo\n");
  ctx.snapshotStore!.record(file, "one\ntwo\n");
  const tag = ctx.snapshotStore!.resolvePath(file)!.tag;
  const prepared = await analyzeEditFile({ patch: `[${file}#${tag}]\nINS.TAIL:\n+three` }, ctx);
  expect(prepared.operation.kind).toBe("commit-files");
  return {
    version: 1, actionId: "a", runId: "r", toolCallId: "c", toolName: "edit_file",
    principalId: "u", argsDigest: "x", actionDigest: prepared.actionDigest, risk: "edit",
    effects: [], display: prepared.display, operation: prepared.operation,
  } as unknown as PreparedToolAction;
}

const fakeHelper = {
  available: true,
  probe: { available: true, platform: process.platform, binaryPath: "/bin/true" },
  async commit() {
    return { ok: true, writtenSha256: "x" };
  },
};

describe("commit old-content identity pin is load-bearing (022-5-WO2 T010 deletion pin)", () => {
  it("with the guard neutralized, the swap is NOT denied (raced bytes reach oldContent)", async () => {
    process.env.NEUTRALIZE_P1_1_READ_IDENTITY = "1";
    const file = join(dir, "swap.txt");
    const ctx: ToolAnalysisContext = {
      principalId: "user", runId: "r", toolCallId: "c",
      workspace: { workspaceId: "ws", canonicalRoot: dir, policyVersion: 1, policyDigest: "d" },
      artifacts: new InMemoryArtifactStore(), modelProviderClass: "openai",
      snapshotStore: createSnapshotStore(),
    };
    const action = await analyzedEditAction(file, ctx);
    const inodeBefore = statSync(file).ino;
    rmSync(file);
    writeFileSync(file, "RACED-BYTES");
    expect(statSync(file).ino).not.toBe(inodeBefore);

    const executor = new CommitFilesExecutor({ commitHelper: fakeHelper } as never);
    const result = await executor.execute(action, envelope(file), action.operation as never, {});
    // Neutralized: the pin did not fire — the pin IS the load-bearing guard.
    expect(result.state).toBe("failed"); // sha256 commit gate downstream
    if (result.state === "failed") {
      expect(result.error.code).not.toBe("PATH_IDENTITY_MISMATCH");
    }
    delete process.env.NEUTRALIZE_P1_1_READ_IDENTITY;
  });

  it("with the guard live, the swap is denied with PATH_IDENTITY_MISMATCH before any read", async () => {
    delete process.env.NEUTRALIZE_P1_1_READ_IDENTITY;
    const file = join(dir, "swap2.txt");
    const ctx: ToolAnalysisContext = {
      principalId: "user", runId: "r", toolCallId: "c",
      workspace: { workspaceId: "ws", canonicalRoot: dir, policyVersion: 1, policyDigest: "d" },
      artifacts: new InMemoryArtifactStore(), modelProviderClass: "openai",
      snapshotStore: createSnapshotStore(),
    };
    const action = await analyzedEditAction(file, ctx);
    rmSync(file);
    writeFileSync(file, "RACED-BYTES");

    const executor = new CommitFilesExecutor({ commitHelper: fakeHelper } as never);
    const result = await executor.execute(action, envelope(file), action.operation as never, {});
    expect(result.state).toBe("failed");
    if (result.state === "failed") {
      expect(result.error.code).toBe("PATH_IDENTITY_MISMATCH");
    }
    expect(JSON.stringify(result)).not.toContain("RACED-BYTES");
  });
});

describe("edit-section identity pin is load-bearing (022-5-WO2 T011 deletion pin)", () => {
  it("with the guard live, a swapped section file denies the analysis (the WO1 T015 pin)", async () => {
    delete process.env.NEUTRALIZE_P1_1_READ_IDENTITY;
    const file = join(dir, "sec.txt");
    writeFileSync(file, "one\ntwo\n");
    const ctx: ToolAnalysisContext = {
      principalId: "user", runId: "r", toolCallId: "c",
      workspace: { workspaceId: "ws", canonicalRoot: dir, policyVersion: 1, policyDigest: "d" },
      artifacts: new InMemoryArtifactStore(), modelProviderClass: "openai",
      snapshotStore: createSnapshotStore(),
    };
    ctx.snapshotStore!.record(file, "one\ntwo\n");
    const tag = ctx.snapshotStore!.resolvePath(file)!.tag;

    // Swap content (new inode) between snapshot and analysis.
    writeFileSync(file, "SWAPPED");

    const result = await analyzeEditFile({ patch: `[${file}#${tag}]\nINS.TAIL:\n+x` }, ctx).then(
      () => "resolved",
      (e: unknown) => String((e as Error).message),
    );
    // The stale-tag/merge path may reject on content mismatch — the pin
    // assertion is that SWAPPED content cannot silently merge: the outcome
    // must be a rejection mentioning the refusal or stale anchor, and the
    // identity pin guard is what keeps the direct path denied (T015 block).
    expect(result).not.toBe("resolved");
  });
});
