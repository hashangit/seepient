/**
 * Inline unified-diff renderer for `write_file` tool calls.
 *
 * Renders the DiffViewLine[] from `computeDiffLines` as green `+` / red `-` /
 * dim ` ` lines with padded line numbers. Unchanged runs not adjacent to a
 * change are collapsed with a `… N unchanged lines skipped` marker (Pi-style,
 * research.md R4). Collapsed-by-default with a `… N more lines` expand hint
 * (Ctrl+O toggles `expanded` globally in app.tsx).
 *
 * Rendered as ONE `<Text>` with nested colored spans separated by `\n` — the
 * canonical ink pattern for multi-line colored text (a `<Box>` of separate
 * `<Text>` rows mis-measures on some line widths).
 */
import React from 'react';
import { Text } from 'ink';
import { useMemo, type ReactNode } from 'react';
import { useTheme } from '../hooks/use-theme.js';
import { computeDiffLines, type DiffViewLine } from '../diff/line-diff.js';

const CONTEXT = 3;           // context lines retained around each changed run
const COLLAPSED_BUDGET = 50; // max diff lines shown when collapsed

type Theme = ReturnType<typeof useTheme>;

type DisplayItem = { type: 'line'; line: DiffViewLine } | { type: 'skip'; count: number };

/** Collapse runs of unchanged context not within `context` lines of a change. */
function collapseContext(lines: DiffViewLine[], context: number): DisplayItem[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].kind !== 'context') {
      const from = Math.max(0, i - context);
      const to = Math.min(lines.length - 1, i + context);
      for (let j = from; j <= to; j++) keep[j] = true;
    }
  }
  const items: DisplayItem[] = [];
  let run = 0;
  for (let i = 0; i < lines.length; i++) {
    if (keep[i]) {
      if (run > 0) { items.push({ type: 'skip', count: run }); run = 0; }
      items.push({ type: 'line', line: lines[i] });
    } else {
      run++;
    }
  }
  if (run > 0) items.push({ type: 'skip', count: run });
  return items;
}

function linePrefix(line: DiffViewLine, width: number): string {
  if (line.kind === 'added') return `+${String(line.newLineNo).padStart(width)} ${line.text}`;
  if (line.kind === 'removed') return `-${String(line.oldLineNo).padStart(width)} ${line.text}`;
  return ` ${String(line.oldLineNo).padStart(width)} ${line.text}`;
}

function lineColor(line: DiffViewLine, theme: Theme): string {
  return line.kind === 'added' ? theme.green : line.kind === 'removed' ? theme.red : theme.fgDim;
}

export const DiffViewer = React.memo(function DiffViewer({ oldContent, newContent, expanded }: {
  oldContent: string | null;
  newContent: string;
  expanded: boolean;
}) {
  const theme = useTheme();
  const lines = useMemo(() => computeDiffLines(oldContent, newContent), [oldContent, newContent]);
  const items = useMemo(() => collapseContext(lines, CONTEXT), [lines]);

  // No diffable lines ⇒ either a brand-new empty file or an empty→empty rewrite.
  if (lines.length === 0) {
    return <Text color={theme.fgDim}> {oldContent === null ? '(new empty file)' : '(no changes)'}</Text>;
  }
  if (!lines.some((l) => l.kind !== 'context')) {
    return <Text color={theme.fgDim}> (no changes)</Text>;
  }

  const maxNo = lines.reduce(
    (m, l) => Math.max(m, l.kind === 'added' ? l.newLineNo : l.kind === 'removed' ? l.oldLineNo : l.newLineNo),
    1,
  );
  const width = String(maxNo).length;

  let shown: DisplayItem[] = items;
  let dropped = 0;
  if (!expanded) {
    const kept: DisplayItem[] = [];
    let count = 0;
    for (const it of items) {
      if (it.type === 'line' && count >= COLLAPSED_BUDGET) { dropped++; continue; }
      kept.push(it);
      if (it.type === 'line') count++;
    }
    shown = kept;
  }
  // Trim a trailing skip marker (nothing follows it).
  if (shown.length > 0 && shown[shown.length - 1].type === 'skip') {
    shown = shown.slice(0, -1);
  }

  const nodes: ReactNode[] = [];
  shown.forEach((it, i) => {
    if (i > 0) nodes.push('\n');
    if (it.type === 'skip') {
      nodes.push(
        <Text key={`s${i}`} color={theme.fgDim}>{` … ${it.count} unchanged line${it.count === 1 ? '' : 's'} skipped`}</Text>,
      );
    } else {
      nodes.push(<Text key={`l${i}`} color={lineColor(it.line, theme)}>{linePrefix(it.line, width)}</Text>);
    }
  });
  if (dropped > 0) {
    nodes.push('\n');
    nodes.push(
      <Text key="more" color={theme.fgDim}>{` … ${dropped} more line${dropped === 1 ? '' : 's'} (Ctrl+O to expand)`}</Text>,
    );
  }

  return <Text>{nodes}</Text>;
});
