import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import React, { useState } from "react";
import { useInput } from "ink";
import { WidgetBlock } from "/Users/hashanw/Developer/seepient/src/adapters/cli/tui/widgets/widget-block.js";
import type { WidgetSpec } from "/Users/hashanw/Developer/seepient/src/adapters/cli/tui/widgets/types.js";

// Faithful repro of the app-level focus cycling across TWO live widgets.
// Mirrors:
//   app.tsx onCycleWidgetFocus  — advances focusedWidgetId
//   message-area.tsx            — interactive = focusedWidgetId === entry.id && !finalized
//   widget-block.tsx            — useInput({ isActive }) gate on plain Enter / arrows
// A dedicated 'c' keystroke stands in for the real Ctrl+T/Tab cycle, so the
// test never conflates "cycle" with "fire action" (both are Enter in the real
// app but on different handlers).

function twoWidgetSpecs(): WidgetSpec[] {
  return [
    {
      id: "wA",
      kind: "product_card",
      props: { title: "Widget A" },
      actions: [
        { id: "a1", label: "ActionA1", style: "primary" },
        { id: "a2", label: "ActionA2", style: "secondary" },
      ],
    },
    {
      id: "wB",
      kind: "product_card",
      props: { title: "Widget B" },
      actions: [
        { id: "b1", label: "ActionB1", style: "primary" },
        { id: "b2", label: "ActionB2", style: "secondary" },
      ],
    },
  ];
}

function Repro() {
  const specs = twoWidgetSpecs();
  const [finalized, setFinalized] = useState<Record<string, boolean>>({ wA: false, wB: false });
  const [focusedWidgetId, setFocusedWidgetId] = useState<string | null>(null);

  const liveIds = specs.map((s) => s.id).filter((id) => !finalized[id]);

  const cycle = () => {
    if (liveIds.length === 0) { setFocusedWidgetId(null); return; }
    const idx = focusedWidgetId ? liveIds.indexOf(focusedWidgetId) : -1;
    const next = idx + 1 >= liveIds.length ? null : liveIds[idx + 1];
    setFocusedWidgetId(next);
  };

  return (
    <>
      {/* Host-level 'c' handler — stands in for use-keybindings Ctrl+T */}
      <Cycler onCycle={cycle} />
      {specs.map((s) => (
        <WidgetBlock
          key={s.id}
          spec={s}
          finalized={!!finalized[s.id]}
          interactive={focusedWidgetId === s.id && !finalized[s.id]}
          onAction={(aid) => actionLog.push({ widget: s.id, action: aid })}
        />
      ))}
      <FocusIndicator focusedWidgetId={focusedWidgetId} />
    </>
  );
}

const actionLog: Array<{ widget: string; action: string }> = [];

function Cycler({ onCycle }: { onCycle: () => void }) {
  useInput((input) => {
    if (input === "c") onCycle();
  });
  return null;
}

function FocusIndicator({ focusedWidgetId }: { focusedWidgetId: string | null }) {
  return null;
}

describe("multi-widget focus repro", () => {
  it("can cycle to and fire the SECOND widget's action", async () => {
    actionLog.length = 0;
    const { stdin } = render(<Repro />);

    // c → cycle to wA (first live widget)
    stdin.write("c");
    await new Promise((r) => setTimeout(r, 40));
    // Enter → fire wA default action (a1)
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 40));

    // c → cycle wA → wB
    stdin.write("c");
    await new Promise((r) => setTimeout(r, 40));
    // Enter → should fire wB default action (b1)
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 40));

    console.log("ACTION LOG:", JSON.stringify(actionLog));

    const bActions = actionLog.filter((x) => x.widget === "wB");
    expect(bActions.length).toBe(1);
    expect(bActions[0].action).toBe("b1");
  });
});
