/**
 * Media input read discipline (spec 022-5, FR-002 pin + FR-004b).
 *
 * Every image/mask input read goes through the same pinned discipline as
 * read_file: authorization-time identity required (absent denies), and a
 * non-regular file (FIFO) must reject within the test timeout instead of
 * blocking the event loop.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, realpathSync, writeFileSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPinnedImage } from "../media.js";
import { PathIdentityMismatchError } from "../../../foundations/errors.js";

function mkfifo(p: string): void {
  execSync(`mkfifo ${JSON.stringify(p)}`);
}

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "seepient-media-id-")));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function identityOf(p: string) {
  const st = statSync(p);
  return { dev: st.dev, ino: st.ino };
}

describe("readPinnedImage (022-5 FR-002/FR-004)", () => {
  it("reads a regular file with the matching identity as base64", async () => {
    const img = join(dir, "in.png");
    writeFileSync(img, "pngbytes");
    const out = await readPinnedImage(img, identityOf(img), "image input", false);
    expect(out.data).toBe(Buffer.from("pngbytes").toString("base64"));
  });

  it("denies when identity is absent (the tool path must always pin)", async () => {
    const img = join(dir, "unpinned.png");
    writeFileSync(img, "pngbytes");
    await expect(readPinnedImage(img, undefined, "image input", false)).rejects.toBeInstanceOf(
      PathIdentityMismatchError,
    );
  });

  it("denies when the identity does not match the opened file", async () => {
    const img = join(dir, "a.png");
    const other = join(dir, "b.png");
    writeFileSync(img, "authorized");
    writeFileSync(other, "different");
    await expect(readPinnedImage(img, identityOf(other), "image input", false)).rejects.toBeInstanceOf(
      PathIdentityMismatchError,
    );
  });

  it("rejects a FIFO input within the test timeout instead of freezing the event loop", async () => {
    const fifo = join(dir, "pipe.png");
    mkfifo(fifo);
    await expect(
      Promise.race([
        readPinnedImage(fifo, identityOf(fifo), "image input", false),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("FIFO open wedged the media read")), 3000)),
      ]),
    ).rejects.toThrow(/not a regular file/i);
  });
});
