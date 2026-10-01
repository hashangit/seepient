/**
 * US0 red gates (022-5-WO4 T002, pass-14 P1-1).
 *
 * (a) SOURCE PIN: snapshot-store.ts must contain no bare `require(` — the
 * vite-node transform supplies a `require` shim under vitest, so a dead
 * bare require is invisible in the test runner but kills the identity
 * capture in every shipped binary (pass-14 P1-1, five-way confirmed).
 * (b) BEHAVIOR PIN: `record()` on a real file must populate `identityOf()`
 * — the direct-call shape the vite shim cannot fake.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, mkdtempSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("snapshot-store arming (022-5-WO4 T002)", () => {
  it("(a) source contains no bare require( (production-shape identity capture)", () => {
    const src = readFileSync(
      join(process.cwd(), "src/foundations/hashline/snapshot-store.ts"),
      "utf-8",
    );
    const withoutComments = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    expect(withoutComments).not.toMatch(/\brequire\s*\(/);
  });

  it("(b) record() on a real file populates identityOf()", async () => {
    const { createSnapshotStore } = await import("../hashline/snapshot-store.js");
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "seepient-store-arm-")));
    try {
      const file = join(dir, "a.txt");
      writeFileSync(file, "one\ntwo\n");
      const store = createSnapshotStore();
      store.record(file, "one\ntwo\n");
      const identity = store.identityOf(file);
      expect(identity, "identityOf must return the recorded dev/ino — null means the capture is dead in this module loading shape").not.toBeNull();
      expect(identity?.device).toBeDefined();
      expect(identity?.inode).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
