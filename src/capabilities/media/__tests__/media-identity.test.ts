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

  it("classifyMediaError passes the read-plane codes through (022-5-WO3 T012 deletion pin)", async () => {
    const { classifyMediaError } = await import("../../../domain/media/vendor-operation-handler.js");
    const err = new Error("Refusing image input: x is a symbolic link");
    (err as { code?: string }).code = "SYMLINK_READ_DENIED";
    expect(classifyMediaError(err, "generate_image", "MEDIA_GENERATION_FAILED").code).toBe("SYMLINK_READ_DENIED");
    const fifo = new Error("Refusing image input: x is not a regular file");
    (fifo as { code?: string }).code = "MEDIA_INPUT_NOT_REGULAR_FILE";
    expect(classifyMediaError(fifo, "generate_image", "MEDIA_GENERATION_FAILED").code).toBe("MEDIA_INPUT_NOT_REGULAR_FILE");
  });

  it("symlink and FIFO refusals carry their refusal reason in the message (022-5-WO1 T016)", async () => {
    const link = join(dir, "link.png");
    const outside = join(dir, "outside.png");
    writeFileSync(outside, "outside");
    execSync(`ln -s ${JSON.stringify(outside)} ${JSON.stringify(link)}`);
    await expect(readPinnedImage(link, undefined, "image input", false)).rejects.toThrow(
      /symbolic link/i,
    );
    const fifo = join(dir, "pipe2.png");
    mkfifo(fifo);
    await expect(readPinnedImage(fifo, identityOf(fifo), "image input", false)).rejects.toThrow(
      /not a regular file/i,
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
