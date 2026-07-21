import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { DiffViewer } from "../components/diff-viewer.js";

// NOTE: newline strings MUST go through JS braces `{"a\nb"}`. JSX attribute
// literals like attr="a\nb" do NOT interpret \n (they're HTML-style), which
// silently turns multi-line content into one literal line.

describe("DiffViewer", () => {
  it("renders all-added lines for a new file", () => {
    const { lastFrame } = render(<DiffViewer oldContent={null} newContent={"alpha\nbeta"} expanded={true} />);
    const out = lastFrame() ?? "";
    expect(out).toContain("+1 alpha");
    expect(out).toContain("+2 beta");
    // a brand-new file has no removed lines
    expect(out).not.toContain("-");
  });

  it("renders added and removed lines on an edit", () => {
    const { lastFrame } = render(<DiffViewer oldContent={"a\nb\nc"} newContent={"a\nB\nc"} expanded={true} />);
    const out = lastFrame() ?? "";
    expect(out).toContain("-2 b");
    expect(out).toContain("+2 B");
  });

  it("shows '(no changes)' for identical content", () => {
    const { lastFrame } = render(<DiffViewer oldContent={"x\ny"} newContent={"x\ny"} expanded={true} />);
    expect(lastFrame() ?? "").toContain("(no changes)");
  });

  it("labels a new empty file distinctly from an identical rewrite", () => {
    const fresh = render(<DiffViewer oldContent={null} newContent={""} expanded={true} />).lastFrame() ?? "";
    expect(fresh).toContain("(new empty file)");
    const same = render(<DiffViewer oldContent={"x"} newContent={"x"} expanded={true} />).lastFrame() ?? "";
    expect(same).toContain("(no changes)");
  });

  it("collapses long unchanged runs between changes", () => {
    // Change line 5 and line 15; the unchanged middle must be elided.
    const old = Array.from({ length: 20 }, (_, i) => `l${i + 1}`).join("\n");
    const lines = Array.from({ length: 20 }, (_, i) => `l${i + 1}`);
    lines[4] = "CHG5";
    lines[14] = "CHG15";
    const next = lines.join("\n");
    const { lastFrame } = render(<DiffViewer oldContent={old} newContent={next} expanded={true} />);
    const out = lastFrame() ?? "";
    expect(out).toContain("unchanged lines skipped");
    expect(out).toContain("CHG5");
    expect(out).toContain("CHG15");
  });

  it("truncates with an expand hint when collapsed and shows full when expanded", () => {
    // 60 added lines exceeds the collapsed budget (50).
    const next = Array.from({ length: 60 }, (_, i) => `n${i + 1}`).join("\n");

    const collapsed = render(<DiffViewer oldContent={null} newContent={next} expanded={false} />).lastFrame() ?? "";
    expect(collapsed).toContain("more line");
    expect(collapsed).toContain("(Ctrl+O to expand)");

    const expanded = render(<DiffViewer oldContent={null} newContent={next} expanded={true} />).lastFrame() ?? "";
    expect(expanded).toContain("+60 n60");
    expect(expanded).not.toContain("(Ctrl+O to expand)");
  });
});
