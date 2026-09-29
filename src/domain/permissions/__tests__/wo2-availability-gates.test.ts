/**
 * US0 red gates (022-5-WO2 T004/T005/T006).
 *
 * T004 — edit_file commits feed the old-content identity pin nothing: the
 * analyzer stamps {exists,size,sha256} into `expected`, the executor pin
 * requires device/inode, so a swapped-inode destination reads raced bytes
 * into oldContent undenied. The gate swaps the destination after analysis
 * and requires PATH_IDENTITY_MISMATCH.
 *
 * T005 (SC-012) — an internal handler throw must produce a 500 response and
 * leave the process alive (today: the async handler rejects into the
 * process-level guard and the response hangs).
 *
 * T006 — readPinnedImage's FIFO and symlink refusals must carry machine
 * codes that survive classifyMediaError (today: code-less plain Errors
 * laundering to MEDIA_GENERATION_FAILED).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, realpathSync, writeFileSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommitFilesExecutor } from "../../../../capabilities/execution/executors.js";
import { readPinnedImage } from "../../../../capabilities/media/media.js";
import { createSnapshotStore } from "../../../../foundations/hashline/snapshot-store.js";
import { InMemoryArtifactStore } from "../../../../capabilities/execution/in-memory-artifact-store.js";
import { analyzeEditFile } from "../../../../capabilities/tools/analyzers.js";
import type { PreparedToolAction } from "../../../../foundations/contracts/prepared-action.js";
import type { CapabilityEnvelope } from "../../../../foundations/contracts/permission-policy.js";
import type { ToolAnalysisContext } from "../../../../foundations/contracts/custom-tools.js";

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "seepient-wo2-gates-")));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function mkfifo(p: string): void {
  execSync(`mkfifo ${JSON.stringify(p)}`);
}

// ── T004 ──────────────────────────────────────────────────────────────────

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

describe("edit commit destination swap (022-5-WO2 T004)", () => {
  it("the old-content identity pin denies a swapped destination with PATH_IDENTITY_MISMATCH", async () => {
    // 1. Analyze a real edit against a real file.
    const file = join(dir, "edit.txt");
    writeFileSync(file, "one\ntwo\n");
    const ctx: ToolAnalysisContext = {
      principalId: "user",
      runId: "r1",
      toolCallId: "c1",
      workspace: { workspaceId: "ws", canonicalRoot: dir, policyVersion: 1, policyDigest: "d" },
      artifacts: new InMemoryArtifactStore(),
      modelProviderClass: "openai",
      snapshotStore: createSnapshotStore(),
    };
    ctx.snapshotStore!.record(file, "one\ntwo\n");
    const tag = ctx.snapshotStore!.resolvePath(file)!.tag;
    const prepared = await analyzeEditFile({ patch: `[${file}#${tag}]\nINS.TAIL:\n+three` }, ctx);
    expect(prepared.operation.kind).toBe("commit-files");
    if (prepared.operation.kind !== "commit-files") return;

    // 2. Swap the destination inode after analysis (same path, new file).
    const inodeBefore = statSync(file).ino;
    rmSync(file);
    writeFileSync(file, "RACED-BYTES");
    expect(statSync(file).ino).not.toBe(inodeBefore);

    // 3. Execute: the old-content pin must deny the swap before reading.
    const executor = new CommitFilesExecutor({
      commitHelper: {
        available: true,
        probe: { available: true, platform: process.platform, binaryPath: "/bin/true" },
        async commit() {
          return { ok: true, writtenSha256: "x" };
        },
      },
    } as never);
    const action = {
      version: 1, actionId: "a", runId: "r", toolCallId: "c", toolName: "edit_file",
      principalId: "u", argsDigest: "x", actionDigest: prepared.actionDigest, risk: "edit",
      effects: [], display: prepared.display,
      operation: prepared.operation,
    } as unknown as PreparedToolAction;
    const result = await Promise.race([
      executor.execute(action, envelope(file), prepared.operation as never, {}),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("commit never settled")), 3000)),
    ]);

    // The commit body itself may fail the sha256 gate downstream — but the
    // OLD-CONTENT read must have been denied by the identity pin first.
    expect(result.state).toBe("failed");
    if (result.state === "failed") {
      expect(result.error.code).toBe("PATH_IDENTITY_MISMATCH");
    }
    expect(JSON.stringify(result)).not.toContain("RACED-BYTES");
  });
});

// ── T006 ──────────────────────────────────────────────────────────────────

describe("media refusal codes survive (022-5-WO2 T006)", () => {
  it("FIFO refusal carries MEDIA_INPUT_NOT_REGULAR_FILE", async () => {
    const fifo = join(dir, "pipe.png");
    mkfifo(fifo);
    const st = statSync(fifo);
    let err: unknown;
    await readPinnedImage(fifo, { dev: st.dev, ino: st.ino }, "image input", false).catch((e: unknown) => {
      err = e;
    });
    expect(err).toBeDefined();
    expect((err as { code?: string }).code).toBe("MEDIA_INPUT_NOT_REGULAR_FILE");
  });

  it("symlink refusal carries SYMLINK_READ_DENIED", async () => {
    const target = join(dir, "target.png");
    writeFileSync(target, "bytes");
    const link = join(dir, "link.png");
    symlinkSyncVoid(target, link);
    let err: unknown;
    await readPinnedImage(link, undefined, "image input", false).catch((e: unknown) => {
      err = e;
    });
    expect(err).toBeDefined();
    expect((err as { code?: string }).code).toBe("SYMLINK_READ_DENIED");
  });
});

function symlinkSyncVoid(target: string, link: string): void {
  execSync(`ln -s ${JSON.stringify(target)} ${JSON.stringify(link)}`);
}
