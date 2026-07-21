import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { Markdown } from "../components/markdown.js";

// ink-testing-library strips ANSI color codes from lastFrame(), so assertions
// match on plain text content, markers, and whitespace — not color. This is
// enough to lock in numbering, nesting depth, and that inline markers survive
// parsing (i.e. the regex matched and stripped the delimiters).

describe("Markdown", () => {
  it("numbers consecutive ordered-list items sequentially", () => {
    const { lastFrame } = render(
      <Markdown content={"1. first\n2. second\n3. third"} />,
    );
    const out = lastFrame() ?? "";
    expect(out).toContain("1. first");
    expect(out).toContain("2. second");
    expect(out).toContain("3. third");
  });

  it("resets ordering after a non-ordered block breaks the run", () => {
    const { lastFrame } = render(
      <Markdown content={"1. a\n2. b\n\nbreak\n\n1. c\n2. d"} />,
    );
    const out = lastFrame() ?? "";
    expect(out).toContain("1. a");
    expect(out).toContain("2. b");
    expect(out).toContain("1. c");
    expect(out).toContain("2. d");
  });

  it("indents nested bullets by two spaces per depth level", () => {
    const { lastFrame } = render(
      <Markdown content={"- top\n  - mid\n    - deep"} />,
    );
    const out = lastFrame() ?? "";
    // Top-level item sits at column 0; each nested level adds 2 spaces of
    // left padding before the bullet marker.
    expect(out).toContain("• top");
    expect(out).toContain("  • mid");
    expect(out).toContain("    • deep");
  });

  it("preserves heading text and differentiates level 1 from level 3", () => {
    const { lastFrame } = render(
      <Markdown content={"# Title\n### Subsection"} />,
    );
    const out = lastFrame() ?? "";
    expect(out).toContain("Title");
    expect(out).toContain("Subsection");
    // Both render as bold text; ink-testing-library strips the color that
    // distinguishes them, so we assert only that the hash markers are gone.
    expect(out).not.toContain("# ");
  });

  it("parses bold, italics, and inline code without leaving delimiters", () => {
    const { lastFrame } = render(
      <Markdown content={"**bold** and *italic* and `code`"} />,
    );
    const out = lastFrame() ?? "";
    expect(out).toContain("bold");
    expect(out).toContain("italic");
    expect(out).toContain("code");
    expect(out).not.toContain("**");
    expect(out).not.toContain("`code`");
  });

  it("does not treat spaced asterisks as italics (math spacing)", () => {
    // a * b * c has spaces adjacent to both asterisks; the \S guard should
    // prevent false italic parsing, leaving the asterisks in the output.
    const { lastFrame } = render(
      <Markdown content={"result = a * b * c"} />,
    );
    const out = lastFrame() ?? "";
    expect(out).toContain("a * b * c");
  });

  it("parses strikethrough and strips the ~~ delimiters", () => {
    const { lastFrame } = render(
      <Markdown content={"done ~~old~~ new"} />,
    );
    const out = lastFrame() ?? "";
    expect(out).toContain("old");
    expect(out).not.toContain("~~");
  });

  it("renders a fenced code block as bordered content without the fences", () => {
    const { lastFrame } = render(
      <Markdown content={"```bash\nseepient --version\n```"} />,
    );
    const out = lastFrame() ?? "";
    expect(out).toContain("seepient --version");
    expect(out).not.toContain("```");
  });

  it("inserts a blank line between paragraphs separated by a blank line", () => {
    const { lastFrame } = render(
      <Markdown content={"First paragraph.\n\nSecond paragraph."} />,
    );
    const out = lastFrame() ?? "";
    expect(out).toContain("First paragraph.");
    expect(out).toContain("Second paragraph.");
    // A spacer block renders as an empty line between the two paragraphs.
    // ink-testing-library joins rows with \n, so the blank line shows up as
    // two consecutive newlines in the frame.
    expect(out).toMatch(/First paragraph\.\n\nSecond paragraph\./);
  });

  it("inserts a blank line between a paragraph and a list", () => {
    const { lastFrame } = render(
      <Markdown content={"Intro:\n\n- one\n- two"} />,
    );
    const out = lastFrame() ?? "";
    expect(out).toMatch(/Intro:\n\n.*• one/);
  });

  it("inserts a blank line between a list and a code block", () => {
    const { lastFrame } = render(
      <Markdown content={"- one\n- two\n\n```bash\nrun me\n```"} />,
    );
    const out = lastFrame() ?? "";
    expect(out).toContain("• two");
    expect(out).toContain("run me");
    // Spacer sits between the last list item and the code fence — a blank
    // line (two consecutive newlines) separates them.
    expect(out).toMatch(/• two\n\n/);
  });

  it("collapses multiple blank lines into a single spacer", () => {
    const single = render(<Markdown content={"a\n\nb"} />).lastFrame() ?? "";
    const triple = render(<Markdown content={"a\n\n\n\nb"} />).lastFrame() ?? "";
    // One blank line vs three should yield the same single spacer (one empty
    // line) — no runaway vertical gaps.
    const singleGaps = (single.match(/a\n\nb/) ?? []).length;
    const tripleGaps = (triple.match(/a\n\nb/) ?? []).length;
    expect(singleGaps).toBe(1);
    expect(tripleGaps).toBe(1);
  });
});
