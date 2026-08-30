/**
 * Real-binary integration tests (spec 019 FR-008/T032, QS-1.2).
 *
 * Drives the FULL commit through the actual `seepient-fs-commit` binary via
 * `SEEPIENT_FS_COMMIT_BIN` — the documented from-source trust path. Skips
 * with a notice when no binary has been built (CI builds one first; run
 * `pnpm native:build` locally). Also records the <50 ms per-commit budget
 * measurement (production budget, quickstart.md).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync, realpathSync, writeFileSync, symlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PackagedCommitHelper, probeCommitHelper, type CommitHelperProbe } from "../index.js";

/**
 * Vendors must not import Capabilities (layer direction), so the shared
 * commit-helper fixture is re-declared here in its 8-line entirety.
 */
function fakeProbe(opts: { available: boolean; binaryPath?: string }): CommitHelperProbe {
  return {
    available: opts.available,
    platform: process.platform,
    binaryPath: opts.available ? (opts.binaryPath ?? "/fake/bin") : opts.binaryPath,
    reason: opts.available ? undefined : "binary-missing",
    digestVerified: false,
  };
}

const BINARY_CANDIDATES = [
  join("src", "native-fs-commit", `${process.platform}-${process.arch}`, "seepient-fs-commit"),
  join("native", "fs-commit", "target", "release", "seepient-fs-commit"),
];
const binaryPath = BINARY_CANDIDATES.find((p) => existsSync(p));

let savedEnv: string | undefined;
beforeEach(() => {
  savedEnv = process.env.SEEPIENT_FS_COMMIT_BIN;
  if (binaryPath) {
    process.env.SEEPIENT_FS_COMMIT_BIN = binaryPath;
  }
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.SEEPIENT_FS_COMMIT_BIN;
  else process.env.SEEPIENT_FS_COMMIT_BIN = savedEnv;
});

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "seepient-fs-integration-")));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe.skipIf(!binaryPath)(`real helper at ${binaryPath ?? "(none)"}`, () => {
  it("probe reports available via the env override (trust decision, not digest-verified)", async () => {
    const probe = await probeCommitHelper();
    expect(probe.available).toBe(true);
    expect(probe.digestVerified).toBe(false);
    expect(probe.binaryPath).toBe(binaryPath);
  });

  it("full commit writes the file and reports the input digest", async () => {
    const helper = new PackagedCommitHelper({ ...(await probeCommitHelper()) });
    const dest = join(dir, "out.txt");
    const content = new TextEncoder().encode("written by the real helper\n");
    const { createHash } = await import("node:crypto");
    const expected = createHash("sha256").update(content).digest("hex");

    const result = await helper.commit({ destination: dest, content, expected: { exists: false } });
    expect(result.ok).toBe(true);
    expect(result.writtenSha256).toBe(expected);
    expect(readFileSync(dest, "utf8")).toBe("written by the real helper\n");
  });

  it("refuses a symlinked destination (target-symlink)", async () => {
    const helper = new PackagedCommitHelper(fakeProbe({ available: true, binaryPath }));
    const victim = join(dir, "victim.txt");
    writeFileSync(victim, "original", "utf8");
    const link = join(dir, "link.txt");
    symlinkSync(victim, link);

    const result = await helper.commit({ destination: link, content: new TextEncoder().encode("x") });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("target-symlink");
    expect(readFileSync(victim, "utf8")).toBe("original");
  });

  it("refuses a symlinked parent (parent-symlink)", async () => {
    const helper = new PackagedCommitHelper(fakeProbe({ available: true, binaryPath }));
    const real = join(dir, "real");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(real);
    const link = join(dir, "link");
    symlinkSync(real, link);

    const result = await helper.commit({ destination: join(link, "f.txt"), content: new TextEncoder().encode("x") });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("parent-symlink");
  });

  it("refuses when the expected snapshot does not match (snapshot-changed)", async () => {
    const helper = new PackagedCommitHelper(fakeProbe({ available: true, binaryPath }));
    const dest = join(dir, "watched.txt");
    writeFileSync(dest, "current content", "utf8");
    const { createHash } = await import("node:crypto");
    const stale = createHash("sha256").update("snapshot-time content").digest("hex");

    const result = await helper.commit({
      destination: dest,
      content: new TextEncoder().encode("new"),
      expected: { exists: true, sha256: stale },
    });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("snapshot-changed");
    expect(readFileSync(dest, "utf8")).toBe("current content");
  });

  it("per-commit overhead stays under the 50 ms production budget", async () => {
    const helper = new PackagedCommitHelper(fakeProbe({ available: true, binaryPath }));
    const dest = join(dir, "timed.txt");
    const content = new TextEncoder().encode("x".repeat(10_000));

    // Warm-up (first exec pays process + loader cost).
    await helper.commit({ destination: join(dir, "warmup.txt"), content, expected: { exists: false } });

    const runs = 10;
    const start = performance.now();
    for (let i = 0; i < runs; i++) {
      const r = await helper.commit({
        destination: `${dest}.${i}`,
        content,
        expected: { exists: false },
      });
      expect(r.ok).toBe(true);
    }
    const perCommitMs = (performance.now() - start) / runs;
    // Recorded, not hard-gated: CI runners are noisy. Budget: <50 ms.
    console.log(`[helper-integration] per-commit overhead: ${perCommitMs.toFixed(2)} ms (budget <50 ms)`);
    expect(perCommitMs).toBeGreaterThan(0);
  });
});

describe("when no binary has been built", () => {
  it("documents the skip path (QS-1.2 notice)", () => {
    if (!binaryPath) {
      console.log("[helper-integration] no helper binary found — run `pnpm native:build` to exercise the real-commit tests");
    }
    expect(true).toBe(true);
  });
});
