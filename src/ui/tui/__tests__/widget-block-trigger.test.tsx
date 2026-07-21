import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { WidgetBlock } from "../widgets/widget-block.js";
import type { WidgetSpec } from "../widgets/types.js";

// Regression: product_card (and all non-form action widgets) used to fire on
// Ctrl+Enter, which macOS terminals don't report as { ctrl: true, return: true }.
// The binding was effectively dead. Now every action widget uses plain Enter +
// ↑/↓ — the same convention as FormWidget. These tests lock in the new scheme.

function productCardSpec(actions: { id: string; label: string }[]): WidgetSpec {
  return {
    id: "pc1",
    kind: "product_card",
    props: { title: "Widget" },
    actions,
  };
}

describe("WidgetBlock action trigger", () => {
  it("fires onAction on Enter when interactive (not Ctrl+Enter)", () => {
    const onAction = vi.fn();
    const { stdin } = render(
      <WidgetBlock
        spec={productCardSpec([{ id: "buy", label: "Buy" }])}
        finalized={false}
        interactive={true}
        onAction={onAction}
      />,
    );
    // Plain Enter — the reliable key on every terminal.
    stdin.write("\r");
    expect(onAction).toHaveBeenCalledTimes(1);
    // onAction is called with the focused action id; the state arg is omitted
    // for non-form widgets (only forms pass state).
    expect(onAction).toHaveBeenCalledWith("buy");
  });

  it("↑/↓ cycles focus across the action bar", async () => {
    const onAction = vi.fn();
    const spec = productCardSpec([
      { id: "buy", label: "Buy" },
      { id: "save", label: "Save" },
    ]);
    const { stdin } = render(
      <WidgetBlock
        spec={spec}
        finalized={false}
        interactive={true}
        onAction={onAction}
      />,
    );
    // Default focus is index 0 ("buy"). ↓ moves to index 1 ("save"). The two
    // writes are separated by a tick so the setFocusIdx re-render commits
    // before Enter reads the new focus index — mirrors real terminal timing
    // where keystrokes arrive on separate event-loop turns.
    stdin.write("\x1b[B"); // down arrow
    // Ink re-renders and re-registers the useInput handler on a later tick;
    // give it enough time to commit the new focusIdx before Enter reads it.
    await new Promise((r) => setTimeout(r, 50));
    stdin.write("\r"); // Enter fires the focused action
    expect(onAction).toHaveBeenCalledWith("save");
  });

  it("does not fire when not interactive", () => {
    const onAction = vi.fn();
    const { stdin } = render(
      <WidgetBlock
        spec={productCardSpec([{ id: "buy", label: "Buy" }])}
        finalized={false}
        interactive={false}
        onAction={onAction}
      />,
    );
    stdin.write("\r");
    expect(onAction).not.toHaveBeenCalled();
  });

  it("does not fire when finalized", () => {
    const onAction = vi.fn();
    const { stdin } = render(
      <WidgetBlock
        spec={productCardSpec([{ id: "buy", label: "Buy" }])}
        finalized={true}
        interactive={true}
        onAction={onAction}
      />,
    );
    stdin.write("\r");
    expect(onAction).not.toHaveBeenCalled();
  });
});
