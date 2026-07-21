import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { allocateWidths, TableWidget } from "../widgets/table.js";
import type { WidgetSpec } from "../widgets/types.js";

// The width allocator is a pure function — these tests pin down its three
// regimes (fill leftover, shrink under overflow, honor weights) without
// depending on Ink's terminal width.

function tableSpec(columns: string[], rows: unknown[][], columnWidths?: Record<string, number>): WidgetSpec {
  const props: Record<string, unknown> = { columns, rows };
  if (columnWidths) props.columnWidths = columnWidths;
  return { id: "t1", kind: "table", props };
}

describe("allocateWidths", () => {
  it("uses natural widths when content fits available space", () => {
    const cols = ["a", "b"];
    const rows = [["1", "2"]];
    const allocs = allocateWidths(cols, rows, 80);
    // "a"+pad=3, "1" max cell=1 → natural 3; floored at MIN_COL 4.
    expect(allocs[0].width).toBeGreaterThanOrEqual(4);
    expect(allocs[1].width).toBeGreaterThanOrEqual(4);
  });

  it("distributes leftover space by weight so the table fills width", () => {
    const cols = ["name", "description", "active"];
    const rows = [["x", "short", "yes"]];
    // No weights: leftover shared by weight 1 each.
    const allocs = allocateWidths(cols, rows, 80);
    const total = allocs.reduce((a, c) => a + c.width, 0);
    // Should fill most of the available width, not hug the left edge.
    expect(total).toBeGreaterThan(60);
  });

  it("gives a weighted column more leftover than an unweighted one", () => {
    const cols = ["a", "b", "c"];
    const rows = [["1", "22", "333"]];
    const flat = allocateWidths(cols, rows, 80);
    const weighted = allocateWidths(cols, rows, 80, { b: 5 });
    // Column "b" should be wider with the hint than without.
    expect(weighted[1].width).toBeGreaterThan(flat[1].width);
    // And the others should not exceed their flat allocation by much.
    expect(weighted[0].width).toBeLessThanOrEqual(flat[0].width);
  });

  it("shrinks columns proportionally when content overflows available width", () => {
    const cols = ["name", "description"];
    const long = "x".repeat(60);
    const rows = [["item", long]];
    const allocs = allocateWidths(cols, rows, 40);
    // Total must not exceed available.
    const total = allocs.reduce((a, c) => a + c.width, 0);
    expect(total).toBeLessThanOrEqual(40);
    // Neither column drops below its minimum (header + pad, floored at 4).
    expect(allocs[0].width).toBeGreaterThanOrEqual(4);
    expect(allocs[1].width).toBeGreaterThanOrEqual(4);
  });

  it("falls back to minimums when even minimums overflow", () => {
    // Many columns, tiny available width → each gets its floor.
    const cols = ["aa", "bb", "cc", "dd", "ee", "ff", "gg", "hh", "ii", "jj"];
    const rows = [["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"]];
    const allocs = allocateWidths(cols, rows, 10);
    // Each min is header(2)+pad(2)=4, floored at 4.
    for (const a of allocs) expect(a.width).toBeGreaterThanOrEqual(4);
  });

  it("fewer columns yield wider columns for the same available width", () => {
    // The core guarantee: a fixed terminal width split among fewer consumers
    // gives each one more space. A 2-column table's per-column width must
    // exceed a 5-column table's per-column width, all else equal.
    const wide = "x".repeat(40); // long enough to be shrinkable, not capped
    const two = allocateWidths(["a", "b"], [[wide, wide]], 80);
    const five = allocateWidths(["a", "b", "c", "d", "e"], [[wide, wide, wide, wide, wide]], 80);
    const twoAvg = two.reduce((s, c) => s + c.width, 0) / two.length;
    const fiveAvg = five.reduce((s, c) => s + c.width, 0) / five.length;
    expect(twoAvg).toBeGreaterThan(fiveAvg);
    // And concretely: a 2-column table fills most of the 80-char width.
    const twoTotal = two.reduce((s, c) => s + c.width, 0);
    expect(twoTotal).toBeGreaterThan(60);
  });

  it("a narrow boolean column stays small while a description column grows", () => {
    // The shape a user actually wants: Yes/No columns stay tight, a
    // description column absorbs the spare width. With a weight hint on the
    // description, it must be the widest column by far.
    const cols = ["active", "description"];
    const rows = [["yes", "a long descriptive sentence about the row"]];
    const allocs = allocateWidths(cols, rows, 80, { description: 3, active: 1 });
    expect(allocs[1].width).toBeGreaterThan(allocs[0].width);
    // The active column should not balloon — under ~20 for a yes/no column.
    expect(allocs[0].width).toBeLessThan(25);
  });
});

describe("TableWidget render", () => {
  it("renders headers and cell values", () => {
    const spec = tableSpec(["Name", "Active"], [["auth", "yes"]]);
    const { lastFrame } = render(<TableWidget spec={spec} />);
    const out = lastFrame() ?? "";
    expect(out).toContain("Name");
    expect(out).toContain("Active");
    expect(out).toContain("auth");
    expect(out).toContain("yes");
  });

  it("truncates long cells to fit the allocated column width", () => {
    // ink-testing-library defaults stdout.columns to 80. A very long
    // description in a 2-column table on 80 cols must be truncated (ellipsis).
    const long = "x".repeat(120);
    const spec = tableSpec(["k", "v"], [["a", long]]);
    const { lastFrame } = render(<TableWidget spec={spec} />);
    const out = lastFrame() ?? "";
    expect(out).toContain("…");
    // The full 120-char value must not survive intact.
    expect(out).not.toContain(long);
  });

  it("shows (empty table) when there are no rows", () => {
    const spec = tableSpec(["a", "b"], []);
    const { lastFrame } = render(<TableWidget spec={spec} />);
    expect(lastFrame() ?? "").toContain("(empty table)");
  });
});
