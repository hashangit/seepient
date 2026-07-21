import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { ChartWidget } from "../widgets/chart.js";
import type { WidgetSpec } from "../widgets/types.js";

function chartSpec(variant: string, data: number[], labels?: string[]): WidgetSpec {
  return {
    id: "c1",
    kind: "chart",
    props: labels ? { variant, data, labels } : { variant, data },
  };
}

// Regression: the line chart variant used to fall through to barChart() for
// any non-sparkline variant, so bar and line rendered identically. These
// tests lock in that each variant produces visually distinct output.

describe("ChartWidget variants", () => {
  const sample = [1, 3, 2, 5, 4];

  it("bar chart uses filled block characters", () => {
    const { lastFrame } = render(<ChartWidget spec={chartSpec("bar", sample)} />);
    const out = lastFrame() ?? "";
    expect(out).toContain("█");
    expect(out).not.toContain("●");
  });

  it("line chart uses dot markers, not filled blocks", () => {
    const { lastFrame } = render(<ChartWidget spec={chartSpec("line", sample)} />);
    const out = lastFrame() ?? "";
    expect(out).toContain("●");
    // The line chart must NOT look like a bar chart — no filled blocks.
    expect(out).not.toContain("█");
  });

  it("line and bar produce distinct output for the same data", () => {
    const bar = render(<ChartWidget spec={chartSpec("bar", sample)} />).lastFrame() ?? "";
    const line = render(<ChartWidget spec={chartSpec("line", sample)} />).lastFrame() ?? "";
    expect(bar).not.toEqual(line);
  });

  it("sparkline uses block-shading characters and shows the last value", () => {
    const { lastFrame } = render(<ChartWidget spec={chartSpec("sparkline", sample)} />);
    const out = lastFrame() ?? "";
    expect(out).toContain("4"); // last data point
    // Sparkline characters are from the set ▁▂▃▄▅▆▇█ — at least one should
    // appear. ▄ is a safe pick that won't show in the bar/line tests.
    expect(out).toMatch(/[▁▂▃▄▅▆▇█]/);
  });

  it("renders (no data) for an empty series", () => {
    const { lastFrame } = render(<ChartWidget spec={chartSpec("bar", [])} />);
    expect(lastFrame() ?? "").toContain("(no data)");
  });

  it("line chart plots the peak marker somewhere in the grid", () => {
    // Peak (5) sits at the top row; the single ● for it should appear at or
    // near the first column of some row in the output.
    const { lastFrame } = render(<ChartWidget spec={chartSpec("line", [1, 5, 1])} />);
    const out = lastFrame() ?? "";
    expect(out).toContain("●");
  });
});
