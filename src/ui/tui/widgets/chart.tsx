import React from 'react';
import { Box, Text } from 'ink';
import type { WidgetSpec } from './types.js';

function barChart(data: number[], labels?: string[]): string[] {
  const maxVal = Math.max(...data, 1);
  const barCount = 20;
  return data.map((val, i) => {
    const barLen = Math.max(0, Math.round((val / maxVal) * barCount));
    const bar = '█'.repeat(barLen);
    const label = labels?.[i] ?? `#${i + 1}`;
    return `${label.padEnd(6)} ${bar} ${val}`;
  });
}

function lineChart(data: number[], labels?: string[]): string[] {
  // 2D ASCII canvas: fixed height, one column per data point. Distinct from
  // barChart's filled horizontal rows — this plots a connected trend across a
  // grid, so the slope and shape of the series are visible at a glance.
  const height = 10;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;

  // For each data point, the row its marker occupies (0 = top of grid).
  const pointRows = data.map((v) =>
    Math.min(height - 1, Math.max(0, Math.round(((max - v) / range) * (height - 1)))),
  );

  // Build the grid row by row, top to bottom.
  const rows: string[] = [];
  for (let r = 0; r < height; r++) {
    let line = '';
    for (let x = 0; x < data.length; x++) {
      const pr = pointRows[x];
      if (pr === r) {
        line += '●';
      } else if (x > 0) {
        // Draw connectors between consecutive points so the trend reads as a
        // line, not scattered dots. The connector sits on the rows between
        // the previous and current point's marker rows.
        const prev = pointRows[x - 1];
        const lo = Math.min(prev, pr);
        const hi = Math.max(prev, pr);
        line += r > lo && r < hi ? '│' : ' ';
      } else {
        line += ' ';
      }
    }
    rows.push(line);
  }

  // X-axis labels: show first, middle, last to avoid crowding on wide series.
  const labelRow = (labels ?? data.map((_, i) => `#${i + 1}`)).map((l) => String(l));
  const first = labelRow[0] ?? '';
  const last = labelRow[labelRow.length - 1] ?? '';
  const lastCol = Math.max(0, data.length - 1);
  const padEnd = Math.max(0, lastCol - first.length + 1);
  rows.push(first + ' '.repeat(padEnd) + last);

  // Footer with the value range for orientation.
  rows.push(`min ${min} · max ${max}`);
  return rows;
}

function sparkline(data: number[]): string {
  const chars = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const range = max - min || 1;
  return data.map((v) => chars[Math.min(Math.floor(((v - min) / range) * (chars.length - 1)), chars.length - 1)]).join('');
}

export const ChartWidget = React.memo(function ChartWidget({ spec }: { spec: WidgetSpec }) {
  const variant = spec.props.variant as string;
  const rawLabels = spec.props.labels as unknown[] | undefined;
  const rawArray = Array.isArray(spec.props.data) ? spec.props.data : [];
  // Coerce every data point to a finite number; drop non-numeric entries.
  const data = rawArray
    .map((d) => Number(d))
    .filter((n) => Number.isFinite(n));
  if (data.length === 0) return <Text color="gray">(no data)</Text>;

  // Normalize labels to strings.
  const labels = Array.isArray(rawLabels)
    ? rawLabels.map((l) => (typeof l === 'string' ? l : String(l ?? '')))
    : undefined;

  if (variant === 'sparkline') {
    return <Text>{sparkline(data)} {data[data.length - 1]}</Text>;
  }

  if (variant === 'line') {
    const lines = lineChart(data, labels);
    return (
      <Box flexDirection="column">
        {lines.map((line, i) => (
          <Text key={i}>{line}</Text>
        ))}
      </Box>
    );
  }

  // Default: bar chart.
  const lines = barChart(data, labels);
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => (
        <Text key={i}>{line}</Text>
      ))}
    </Box>
  );
});
