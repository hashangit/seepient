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
    // Deterministic swap: the replacement is created while the original is
    // alive (distinct inode guaranteed), then renamed over the path. Linux
    // reuses a freed inode immediately, so rm+recreate is NOT deterministic.
    const replacement = join(dir, "replacement.tmp");
    writeFileSync(replacement, "RACED-BYTES");
    const { renameSync } = await import("node:fs");
    renameSync(replacement, file);

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
    const replacement = join(dir, "replacement2.tmp");
    writeFileSync(replacement, "RACED-BYTES");
    const { renameSync } = await import("node:fs");
    renameSync(replacement, file);

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
  it("with the guard live, a REAL inode swap (content preserved) denies the section read", async () => {
    delete process.env.NEUTRALIZE_P1_1_READ_IDENTITY;
    const { denyMessage } = await runSectionSwap();
    // The identity pin fires: the denial is the identity mismatch, not a
    // stale-anchor artifact (content is identical — only the inode moved).
    expect(denyMessage).toMatch(/identity|PATH_IDENTITY_MISMATCH/i);
  });

  it("with the guard neutralized, the same swap is NOT identity-denied (the pin is load-bearing)", async () => {
    process.env.NEUTRALIZE_P1_1_READ_IDENTITY = "1";
    try {
      const { denyMessage } = await runSectionSwap();
      expect(denyMessage).not.toMatch(/identity|PATH_IDENTITY_MISMATCH/i);
    } finally {
      delete process.env.NEUTRALIZE_P1_1_READ_IDENTITY;
    }
  });

  /** Real inode swap with IDENTICAL content: create a replacement file with
   *  the same bytes while the original is alive, rename over the path. The
   *  stale-anchor path cannot fire (same content, same tag) — the only
   *  difference from the snapshot is the inode, which is exactly what the
   *  section-read pin exists to catch. (Pass-13 P3: the old "swap" was an
   *  in-place write — same inode, pin never fired.) */
  async function runSectionSwap(): Promise<{ denyMessage: string }> {
    const file = join(dir, `sec-${Math.random().toString(36).slice(2, 8)}.txt`);
    writeFileSync(file, "one\ntwo\n");
    const ctx: ToolAnalysisContext = {
      principalId: "user", runId: "r", toolCallId: "c",
      workspace: { workspaceId: "ws", canonicalRoot: dir, policyVersion: 1, policyDigest: "d" },
      artifacts: new InMemoryArtifactStore(), modelProviderClass: "openai",
      snapshotStore: createSnapshotStore(),
    };
    ctx.snapshotStore!.record(file, "one\ntwo\n");
    const tag = ctx.snapshotStore!.resolvePath(file)!.tag;

    const replacement = `${file}.new`;
    writeFileSync(replacement, "one\ntwo\n"); // identical content, new inode
    const { renameSync } = await import("node:fs");
    renameSync(replacement, file);

    const message = await analyzeEditFile({ patch: `[${file}#${tag}]\nINS.TAIL:\n+x` }, ctx).then(
      () => "resolved",
      (e: unknown) => String((e as Error).message),
    );
    if (message === "resolved") {
      return { denyMessage: "" };
    }
    return { denyMessage: message };
  }
});
