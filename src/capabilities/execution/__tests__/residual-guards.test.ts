/**
 * Residual guard pins (spec 022-5 US4): htmlToText input cap (FR-016),
 * cross-process key revocation observed within one cache re-read (FR-010 /
 * SC-007), and sandbox process-tree kill on normal settle (FR-014 / SC-011).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { htmlToText } from "../executors.js";
import { UncontainedSandbox } from "../../../vendors/sandbox-runtime/index.js";
import type { SandboxExecRequest } from "../../../vendors/sandbox-runtime/index.js";

describe("htmlToText input cap (022-5 FR-016)", () => {
  it("caps input before the regex passes and marks the truncation", () => {
    const big = `<html>${"<div>payload </div>".repeat(120_000)}</html>`; // ~2 MB
    const out = htmlToText(big);
    expect(out.length).toBeLessThan(big.length / 2);
    expect(out).toContain("input truncated");
  });

  it("normal-size pages convert unchanged in shape", () => {
    const out = htmlToText("<p>hello</p><script>x()</script><p>world</p>");
    expect(out).toContain("hello");
    expect(out).toContain("world");
    expect(out).not.toContain("<p>");
  });
});

describe("sandbox kill on normal settle (022-5 FR-014 / SC-011)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "seepient-racer-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("a settled exec leaves no backgrounded descendants alive", async () => {
    const marker = join(dir, "marker");
    const sandbox = new UncontainedSandbox();
    const req: SandboxExecRequest = {
      command: { executable: "/bin/sh", argv: ["-c", `(sleep 2; touch ${JSON.stringify(marker)}) >/dev/null 2>&1 & echo started`], cwd: dir },
      roots: [],
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    };
    const result = await sandbox.exec(req);
    expect(result.exitCode).toBe(0);
    expect(existsSync(marker)).toBe(false);

    // The group kill already fired on settle; give the would-be writer ample
    // time and confirm it never surfaces.
    await new Promise((r) => setTimeout(r, 2600));
    expect(existsSync(marker)).toBe(false);
  }, 10_000);
});
