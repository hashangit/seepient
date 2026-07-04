import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// `fs/promises` is the real module except `rename`, which is a delegating mock
// so a single test can simulate a crash. The ESM namespace isn't configurable,
// so spyOn won't work — vi.mock with an importActual override is the way.
vi.mock("fs/promises", async (importActual) => {
  const actual = await importActual() as typeof import("fs/promises");
  return { ...actual, rename: vi.fn(actual.rename) };
});

import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { WriteFileTool } from "../core.js";

describe("WriteFileTool (safe atomic write)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "seepient-write-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const run = (file: string, content: string) =>
    WriteFileTool.handler({ path: file, content });

  it("creates a new file atomically and reports isNewFile", async () => {
    const file = path.join(dir, "new.txt");
    const result: any = await run(file, "hello\nworld");

    expect(result.success).toBe(true);
    expect(result.metadata.isNewFile).toBe(true);
    expect(result.metadata.oldContent).toBeNull();
    expect(result.metadata.newContent).toBe("hello\nworld");
    expect(result.output).toMatch(/Successfully wrote to .* \(0 -> 2 lines\)/);

    await expect(fs.readFile(file, "utf-8")).resolves.toBe("hello\nworld");
    // no orphan temp file left behind
    await expect(fs.readdir(dir)).resolves.toEqual(["new.txt"]);
  });

  it("captures old + new content on overwrite", async () => {
    const file = path.join(dir, "edit.txt");
    await fs.writeFile(file, "a\nb\nc", "utf-8");

    const result: any = await run(file, "a\nB\nc");

    expect(result.metadata.isNewFile).toBe(false);
    expect(result.metadata.oldContent).toBe("a\nb\nc");
    expect(result.metadata.newContent).toBe("a\nB\nc");
    expect(result.output).toMatch(/3 -> 3 lines/);
    await expect(fs.readFile(file, "utf-8")).resolves.toBe("a\nB\nc");
  });

  it("leaves the original intact and cleans the temp when rename fails", async () => {
    const file = path.join(dir, "crash.txt");
    await fs.writeFile(file, "ORIGINAL", "utf-8");

    // The handler calls rename exactly once for this file.
    vi.mocked(fs.rename).mockRejectedValueOnce(new Error("rename boom"));
    const result: any = await run(file, "CHANGED");

    expect(result.success).toBe(false);
    expect(result.output).toMatch(/Error writing file: rename boom/);
    // original never partially overwritten
    await expect(fs.readFile(file, "utf-8")).resolves.toBe("ORIGINAL");
    // temp file cleaned up — only the original remains
    await expect(fs.readdir(dir)).resolves.toEqual(["crash.txt"]);
  });

  it("skips the diff payload for oversized content", async () => {
    const file = path.join(dir, "big.txt");
    const big = "x".repeat(64 * 1024 + 1);

    const result: any = await run(file, big);

    expect(result.metadata.diffSkipped).toBe(true);
    expect(result.metadata.newContent).toBeUndefined();
    expect(result.metadata.oldContent).toBeUndefined();
    await expect(fs.readFile(file, "utf-8")).resolves.toBe(big);
  });

  it("skips the diff when the existing file is large, even for a tiny edit", async () => {
    // Old file exceeds the cap; new content is tiny. The cap must consider the
    // OLD side too — otherwise the whole large file would be read and stored.
    const file = path.join(dir, "big-old.txt");
    await fs.writeFile(file, "x".repeat(64 * 1024 + 1), "utf-8");

    const result: any = await run(file, "tiny");

    expect(result.metadata.diffSkipped).toBe(true);
    expect(result.metadata.oldContent).toBeUndefined();
    expect(result.metadata.isNewFile).toBe(false);
    await expect(fs.readFile(file, "utf-8")).resolves.toBe("tiny");
  });

  it("skips the diff when the existing file has too many lines (under the byte cap)", async () => {
    // 2500 very short lines — well under the 64KB byte cap but over the 2000-line cap.
    const file = path.join(dir, "many-lines.txt");
    await fs.writeFile(file, "l\n".repeat(2500), "utf-8");

    const result: any = await run(file, "x");

    expect(result.metadata.diffSkipped).toBe(true);
    expect(result.metadata.oldContent).toBeUndefined();
    expect(result.metadata.isNewFile).toBe(false);
    await expect(fs.readFile(file, "utf-8")).resolves.toBe("x");
  });

  it("sweeps a same-path temp orphaned by a prior hard kill", async () => {
    const file = path.join(dir, "sweep.txt");
    await fs.writeFile(file, "ORIGINAL", "utf-8");
    const orphan = `${file}.seepient-deadbeef.tmp`;
    await fs.writeFile(orphan, "partial", "utf-8");
    // Age the orphan past the staleness threshold so the sweep treats it as dead.
    const old = Math.floor((Date.now() - 120_000) / 1000);
    await fs.utimes(orphan, old, old);

    await run(file, "NEW");

    // Orphan gone; the file holds the new content; nothing else left behind.
    await expect(fs.readdir(dir)).resolves.toEqual(["sweep.txt"]);
    await expect(fs.readFile(file, "utf-8")).resolves.toBe("NEW");
  });

  it("leaves a peer's fresh in-flight temp untouched (no cross-process race)", async () => {
    const file = path.join(dir, "race.txt");
    await fs.writeFile(file, "ORIGINAL", "utf-8");
    // A temp that looks like another process's live write (just created, ~now).
    const live = `${file}.seepient-fresh.tmp`;
    await fs.writeFile(live, "in-flight", "utf-8");

    const result: any = await run(file, "NEW");

    expect(result.success).toBe(true);
    // The peer's fresh temp survives the sweep; the file got the new content.
    await expect(fs.readFile(live, "utf-8")).resolves.toBe("in-flight");
    await expect(fs.readFile(file, "utf-8")).resolves.toBe("NEW");
  });
});
