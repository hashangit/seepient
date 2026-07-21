import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { ToolCallBlock } from "../components/tool-call-block.js";
import type { ToolCallEntry } from "../types.js";
import type { FileWriteMetadata } from "../../../capabilities/tools/core.js";

describe("ToolCallBlock — write_file diff wiring", () => {
  it("renders an inline diff when write_file carries metadata", () => {
    const meta: FileWriteMetadata = {
      path: "/a.txt",
      oldContent: "old",
      newContent: "new",
      isNewFile: false,
      byteDelta: 0,
    };
    const entry: ToolCallEntry = {
      id: "t1",
      kind: "tool",
      name: "write_file",
      args: { path: "/a.txt" },
      status: "ok",
      output: "Successfully wrote to /a.txt (1 -> 1 lines)",
      metadata: meta,
    };

    const out = render(<ToolCallBlock entry={entry} expanded={true} />).lastFrame() ?? "";

    expect(out).toContain("write_file");   // header present
    expect(out).toContain("-1 old");        // removed line
    expect(out).toContain("+1 new");        // added line
  });

  it("falls back to plain output when the write was too large to diff", () => {
    const meta: FileWriteMetadata = {
      path: "/big.txt",
      isNewFile: true,
      byteDelta: 70_000,
      diffSkipped: true,
      skipReason: "too big",
    };
    const entry: ToolCallEntry = {
      id: "t2",
      kind: "tool",
      name: "write_file",
      args: { path: "/big.txt" },
      status: "ok",
      output: "Successfully wrote to /big.txt (0 -> 900 lines)",
      metadata: meta,
    };

    const out = render(<ToolCallBlock entry={entry} expanded={true} />).lastFrame() ?? "";

    expect(out).toContain("Successfully wrote to /big.txt");
    expect(out).not.toContain("-1 ");
    expect(out).not.toContain("+1 ");
  });

  it("falls back to plain output when write_file has no metadata (e.g. after resume)", () => {
    const entry: ToolCallEntry = {
      id: "t3",
      kind: "tool",
      name: "write_file",
      args: { path: "/a.txt" },
      status: "ok",
      output: "Successfully wrote to /a.txt (0 -> 1 lines)",
      // no metadata
    };

    const out = render(<ToolCallBlock entry={entry} expanded={true} />).lastFrame() ?? "";

    expect(out).toContain("Successfully wrote to /a.txt");
    expect(out).not.toContain("-1 ");
  });
});
