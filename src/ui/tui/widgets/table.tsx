import React from 'react';
import { Box, Text, useStdout } from 'ink';
import type { WidgetSpec } from './types.js';

// ── width allocation ───────────────────────────────────────────────────
//
// The table distributes available terminal width across columns so it fills
// the space where possible instead of hugging the left edge. Each column gets:
//   - a minimum width (header text + padding, floored at 4) so the header
//     never truncates;
//   - a natural width (longest cell, capped at NATURAL_CAP, + padding);
//   - an optional weight from the LLM's `columnWidths` hint, used to steer
//     how leftover space is shared (e.g. give a Description column more and
//     a Yes/No column less).
//
// The allocator is a pure function so it can be unit-tested without Ink.

/** Cells longer than this don't inflate a column's natural width on their own. */
const NATURAL_CAP = 40;
/** Padding (chars) added to every column for breathing room. */
const COL_PAD = 2;
/** Floor for any column so very short headers still read. */
const MIN_COL = 4;
/** Conservative chrome allowance: root HORIZONTAL_PADDING (×2), widget border
 *  + paddingLeft/Right (4), and the marginRight gap per column is accounted
 *  for by the caller. Kept a little generous to avoid edge auto-wrap. */
const CHROME = 8;

/** Truncate a string to `width` chars, reserving 1 char for an ellipsis. */
function truncateTo(value: unknown, width: number): string {
  const s = String(value ?? '');
  if (s.length <= width) return s;
  if (width <= 1) return s.slice(0, width);
  return `${s.slice(0, width - 1)}…`;
}

export interface ColumnAlloc {
  width: number;
}

/**
 * Allocate a width per column given available space, content, and optional
 * LLM-supplied relative weights.
 *
 * Algorithm:
 *  1. Compute each column's min and natural width.
 *  2. If sum(natural) ≤ available → use natural widths; share any leftover
 *     space by weight so the table fills the terminal (wide terminals show
 *     more, instead of leaving a dead strip on the right).
 *  3. If sum(natural) > available → shrink. Columns over their min absorb the
 *     overage proportionally, never dropping below min. Cells that exceed
 *     their allocated width are truncated at render time.
 *
 * `weights` is optional; column names not present default to weight 1.
 */
export function allocateWidths(
  columns: string[],
  rows: unknown[][],
  available: number,
  weights?: Record<string, number>,
): ColumnAlloc[] {
  const n = columns.length;
  if (n === 0) return [];

  const mins = columns.map((c) => Math.max(MIN_COL, c.length + COL_PAD));
  const naturals = columns.map((c, ci) => {
    let maxCell = c.length;
    for (const row of rows) {
      const len = String(row[ci] ?? '').length;
      if (len > maxCell) maxCell = len;
    }
    return Math.max(mins[ci], Math.min(maxCell, NATURAL_CAP) + COL_PAD);
  });

  const totalNatural = naturals.reduce((a, b) => a + b, 0);

  if (totalNatural <= available) {
    // Leftover space distributed by weight; weighted columns grow beyond
    // their natural width, unweighted ones stay natural.
    const leftover = available - totalNatural;
    const weightOf = (ci: number) => Math.max(1, weights?.[columns[ci]] ?? 1);
    const totalWeight = columns.reduce((a, _, ci) => a + weightOf(ci), 0);
    return naturals.map((nat, ci) => ({
      width: nat + Math.floor((leftover * weightOf(ci)) / totalWeight),
    }));
  }

  // Over-committed: shrink proportionally, floor at min.
  const totalMin = mins.reduce((a, b) => a + b, 0);
  if (totalMin >= available) {
    // Even minimums overflow — just use minimums; cells truncate.
    return mins.map((m) => ({ width: m }));
  }
  const overage = totalNatural - available;
  const shrinkable = naturals.map((nat, ci) => nat - mins[ci]);
  const totalShrinkable = shrinkable.reduce((a, b) => a + b, 0);
  return naturals.map((nat, ci) => {
    if (totalShrinkable === 0) return { width: nat };
    const cut = Math.min(shrinkable[ci], Math.ceil((overage * shrinkable[ci]) / totalShrinkable));
    return { width: nat - cut };
  });
}

export const TableWidget = React.memo(function TableWidget({ spec }: { spec: WidgetSpec }) {
  const { stdout } = useStdout();
  const columns = (spec.props.columns as string[]) ?? [];
  const rows = (spec.props.rows as unknown[][]) ?? [];
  const weights = spec.props.columnWidths as Record<string, number> | undefined;
  if (columns.length === 0 || rows.length === 0) return <Text color="gray">(empty table)</Text>;

  const termWidth = stdout?.columns ?? 80;
  const available = Math.max(20, termWidth - CHROME);
  const allocs = allocateWidths(columns, rows, available, weights);

  return (
    <Box flexDirection="column">
      <Box>
        {columns.map((col, i) => (
          <Box key={i} width={allocs[i]?.width ?? 10}>
            <Text bold>{truncateTo(col, allocs[i]?.width ?? 10)}</Text>
          </Box>
        ))}
      </Box>
      {rows.map((row, ri) => (
        <Box key={ri}>
          {columns.map((_, ci) => (
            <Box key={ci} width={allocs[ci]?.width ?? 10}>
              <Text wrap="truncate">{truncateCell(row[ci], allocs[ci]?.width ?? 10)}</Text>
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  );
});

// truncateCell keeps the legacy name for any external reference; it now takes
// the allocated column width instead of a fixed 30.
function truncateCell(value: unknown, width: number): string {
  return truncateTo(value, width);
}
