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
import { analyzeGenerateImage } from "../analyzers.js";
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
    const action = await analyzeGenerateImage({ prompt: "a sunset", image_path: dest }, ctx);

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
      const action = await analyzeGenerateImage({ prompt: "offline", image_path: dest }, ctx);
      expect(action.actionDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(action.effects.some((e) => e.kind === "filesystem-write")).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("no destination ⇒ unchanged broker op (no write effect, no outputCommit)", async () => {
    const action = await analyzeGenerateImage({ prompt: "just a url" }, ctx);
    expect(action.operation.kind).toBe("broker");
    if (action.operation.kind !== "broker") return;
    const request = action.operation.request as { outputCommit?: unknown };
    expect(request.outputCommit).toBeUndefined();
    expect(action.effects.some((e) => e.kind === "filesystem-write")).toBe(false);
  });
});
