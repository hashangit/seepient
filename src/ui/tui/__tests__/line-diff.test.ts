import { describe, it, expect } from "vitest";
import { computeDiffLines } from "../diff/line-diff.js";

describe("computeDiffLines", () => {
  it("marks every line as added for a new file (oldContent === null)", () => {
    const lines = computeDiffLines(null, "a\nb\nc");
    expect(lines.map((l) => l.kind)).toEqual(["added", "added", "added"]);
    expect(lines.map((l) => l.kind === "added" && l.newLineNo)).toEqual([1, 2, 3]);
  });

  it("reports added + removed lines on an edit", () => {
    const lines = computeDiffLines("a\nb\nc", "a\nB\nc");
    const kinds = lines.map((l) => ({ k: l.kind, t: l.text }));
    expect(kinds).toContainEqual({ k: "removed", t: "b" });
    expect(kinds).toContainEqual({ k: "added", t: "B" });
  });

  it("returns only context (no changes) for identical content", () => {
    const lines = computeDiffLines("x\ny", "x\ny");
    expect(lines.every((l) => l.kind === "context")).toBe(true);
  });

  it("normalizes CRLF so a CRLF file does not diff as fully-changed", () => {
    // Same logical content, one with CRLF, one with LF — only line endings differ.
    const lines = computeDiffLines("a\r\nb\r\nc", "a\nb\nc");
    expect(lines.every((l) => l.kind === "context")).toBe(true);
  });

  it("tracks old and new line numbers through a change", () => {
    // Insert one line after the first: old [1,2,3] -> new [1,2,3,4].
    const lines = computeDiffLines("a\nb\nc", "a\nX\nb\nc");
    const added = lines.find((l) => l.kind === "added");
    expect(added).toBeDefined();
    expect(added && added.kind === "added" && added.newLineNo).toBe(2);
  });
});
