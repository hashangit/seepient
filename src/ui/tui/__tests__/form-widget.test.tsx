import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { FormWidget } from "../widgets/form.js";
import type { WidgetSpec } from "../widgets/types.js";

// Regression: select fields showed "undefined_" when the LLM emitted options
// whose shape didn't match the renderer's {value, label} expectation. The
// renderer reads opt.label; if missing it must degrade to a placeholder, not
// render the literal string "undefined". These tests lock in both the
// well-formed path and the graceful-degradation path.

function formSpec(fields: unknown[]): WidgetSpec {
  return {
    id: "f1",
    kind: "form",
    props: { fields },
    actions: [{ id: "submit", label: "Submit" }],
  };
}

describe("FormWidget select field", () => {
  it("shows the option label (not 'undefined') for well-formed {value,label} options", () => {
    const { lastFrame } = render(
      <FormWidget
        spec={formSpec([
          {
            id: "plan",
            label: "Plan",
            type: "select",
            options: [
              { value: "free", label: "Free" },
              { value: "pro", label: "Pro" },
            ],
          },
        ])}
        finalized={false}
        interactive={false}
      />,
    );
    const out = lastFrame() ?? "";
    // First option is selected by default → its label renders.
    expect(out).toContain("Free");
    expect(out).not.toContain("undefined");
  });

  it("degrades to placeholder (not 'undefined') when an option is missing label", () => {
    const { lastFrame } = render(
      <FormWidget
        spec={formSpec([
          {
            id: "plan",
            label: "Plan",
            type: "select",
            placeholder: "(choose)",
            // Malformed: no label key — simulates the LLM emitting a wrong shape.
            options: [{ value: "free" }],
          },
        ])}
        finalized={false}
        interactive={false}
      />,
    );
    const out = lastFrame() ?? "";
    // Must NOT leak the literal "undefined" — fall back to the placeholder.
    expect(out).not.toContain("undefined");
    expect(out).toContain("(choose)");
  });

  it("does not show 'undefined' for text fields with empty values", () => {
    const { lastFrame } = render(
      <FormWidget
        spec={formSpec([
          { id: "name", label: "Name", type: "text", placeholder: "your name" },
        ])}
        finalized={false}
        interactive={false}
      />,
    );
    const out = lastFrame() ?? "";
    expect(out).not.toContain("undefined");
    expect(out).toContain("your name");
  });
});
