/**
 * 013 T007 — ModelPicker component tests (contract model-manager-dock.md §4).
 * ink-testing-library note: setState from useInput renders on the next tick —
 * every stdin write goes through `type()` which awaits a frame.
 */
import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { ModelPicker } from "../model-picker.js";
import type { PurposeDef, PurposeId, AssignmentTarget } from "../../../../transport/cli/provider-manager-api.js";

import type { AvailableModel } from "../../../../domain/providers/model-catalog.js";

const UP = "\u001B[A";
const DOWN = "\u001B[B";
const ENTER = "\r";
const ESC = "\u001B";
const BACKSPACE = "\u007F";

const delay = (ms = 20) => new Promise<void>((r) => setTimeout(r, ms));

async function type(inst: { stdin: { write(s: string): void } }, s: string): Promise<void> {
  inst.stdin.write(s);
  await delay();
}

function model(id: string, provider: string, over: Record<string, unknown> = {}): AvailableModel {
  return {
    id,
    upstreamProvider: provider,
    displayName: id.replace(/-/g, " "),
    contextWindow: 200_000,
    capabilities: { toolUse: true, streaming: true, vision: false },
    supportedReasoningLevels: ["none", "low", "high"] as const,
    provenance: "pi-catalog" as const,
    reachableVia: [],
    ...over,
  } as AvailableModel;
}

function fixtures() {
  const models = [
    model("acme-one", "acme", { reachableVia: ["acme-main"] }),
    model("acme-two", "acme", { reachableVia: ["acme-main"] }),
    model("gpt-4o", "openai", { displayName: "GPT 4o" }), // unreachable, digit-full id
    model("gemini-flash", "google", { displayName: "Gemini Flash" }),
  ];
  const purposes: PurposeDef[] = [
    { id: "text", label: "Text (writing)", tiered: true, requires: ["toolUse", "streaming"] },
    { id: "vision", label: "Vision analysis", tiered: true, requires: ["toolUse", "streaming", "vision"] },
  ];
  const assignments: any = {
    text: { standard: { providerAccount: "acme-main", model: "acme-one" } },
  };
  return { models, purposes, assignments };
}

function setup(over: Partial<Parameters<typeof ModelPicker>[0]> = {}) {
  const { models, purposes, assignments } = fixtures();
  const onAssign = vi.fn(async (_t: AssignmentTarget) => null);
  const onSessionSwitch = vi.fn();
  const onConnectProvider = vi.fn();
  const onClose = vi.fn();
  const props = {
    mode: "assign" as const,
    title: "Assign text·standard",
    purposes,
    assignments,
    models,
    activePurpose: "text" as PurposeId,
    onAssign,
    onSessionSwitch,
    onConnectProvider,
    onClose,
    ...over,
  };
  const inst = render(<ModelPicker {...props} />);
  return { inst, props };
}

describe("ModelPicker — search bar owns typing", () => {
  it("filters live across provider/id/name and digits type into search", async () => {
    const { inst } = setup();
    await type(inst, "gp");
    let frame = inst.lastFrame() ?? "";
    expect(frame).toContain("gpt-4o");
    expect(frame).not.toContain("acme-one");
    await type(inst, BACKSPACE); // "g"
    await type(inst, BACKSPACE); // ""
    await type(inst, "4");
    await type(inst, "o");
    frame = inst.lastFrame() ?? "";
    expect(frame).toContain("gpt-4o");
  });

  it("prefills search from the prefill prop", () => {
    const { inst } = setup({ prefill: "gemini" });
    expect(inst.lastFrame() ?? "").toContain("Gemini Flash");
  });
});

describe("ModelPicker — grouping, windowing, dimming", () => {
  it("renders provider group headers and job badges", () => {
    const { inst } = setup();
    const frame = inst.lastFrame() ?? "";
    expect(frame).toContain("acme");
    expect(frame).toContain("google");
    expect(frame).toContain("text·standard"); // job badge on acme-one
  });

  it("dims unreachable rows with a not-connected label", () => {
    const { inst } = setup();
    expect(inst.lastFrame() ?? "").toContain("not connected");
  });

  it("dims capability-mismatched rows with the reason", () => {
    const { inst } = setup({ activePurpose: "vision" });
    expect(inst.lastFrame() ?? "").toContain("image understanding");
  });

  it("shows price and context per row; unknown pricing is never zero", () => {
    const { models, purposes, assignments } = fixtures();
    models.push({
      ...model("pricy", "acme", {
        reachableVia: ["acme-main"],
        pricing: { promptPerMillion: 3, completionPerMillion: 15 },
      }),
    });
    const inst = render(
      <ModelPicker
        mode="assign" title="t" purposes={purposes} assignments={assignments} models={models}
        activePurpose="text" onAssign={async () => null} onSessionSwitch={() => {}} onConnectProvider={() => {}} onClose={() => {}}
      />,
    );
    const frame = inst.lastFrame() ?? "";
    expect(frame).toContain("$3.00");
    expect(frame).toContain("unknown");
    expect(frame).toContain("200k");
  });

  it("windows long lists to ≤ 10 visible rows", () => {
    const many = Array.from({ length: 25 }, (_v, i) =>
      model(`m-${String(i).padStart(2, "0")}`, "bulk", { reachableVia: ["acct"] }),
    );
    const inst = render(
      <ModelPicker
        mode="assign" title="t" purposes={fixtures().purposes} assignments={{}} models={many}
        activePurpose="text" onAssign={async () => null} onSessionSwitch={() => {}} onConnectProvider={() => {}} onClose={() => {}}
      />,
    );
    const frame = inst.lastFrame() ?? "";
    expect(frame).toContain("m-00");
    expect(frame).not.toContain("m-20"); // beyond the window
  });
});

describe("ModelPicker — action bar (§0.3)", () => {
  it("renders numbered labeled actions; hides session switch in wizard mode", () => {
    const withSession = setup().inst.lastFrame() ?? "";
    expect(withSession).toContain("[1] Connect provider");
    expect(withSession).toContain("[2] Try for this session");
    const wizard = setup({ canSessionSwitch: false }).inst.lastFrame() ?? "";
    expect(wizard).toContain("[1] Connect provider");
    expect(wizard).not.toContain("[2] Try for this session");
  });

  it("↓ past the last row focuses actions; digits activate then", async () => {
    const { inst } = setup({ models: [model("solo", "acme", { reachableVia: ["acme-main"] })] });
    await type(inst, DOWN); // selection already at last row → overflow focuses actions
    await type(inst, "3");  // toggle reachable-only
    expect(inst.lastFrame() ?? "").toContain("Reachable only ✓");
  });

  it("Enter on a dimmed row opens the numbered connect prompt; 1 connects", async () => {
    const { inst, props } = setup();
    await type(inst, "gpt");   // only the dimmed row remains
    await type(inst, ENTER);   // enter on dimmed → connect prompt
    expect(inst.lastFrame() ?? "").toContain("[1] Connect openai");
    await type(inst, "1");
    expect(props.onConnectProvider).toHaveBeenCalledWith("openai");
  });

  it("session switch action calls back with the first reachable account", async () => {
    const { inst, props } = setup({ models: [model("solo", "acme", { reachableVia: ["acme-main"] })] });
    await type(inst, DOWN);
    await type(inst, "2");
    expect(props.onSessionSwitch).toHaveBeenCalledWith("acme-main", "solo");
  });
});

describe("ModelPicker — thinking step (§4.1)", () => {
  it("offers only supported levels, numbered; assigns with the chosen level", async () => {
    const { inst, props } = setup({ models: [model("solo", "acme", { reachableVia: ["acme-main"] })] });
    await type(inst, ENTER); // thinking step
    const frame = inst.lastFrame() ?? "";
    expect(frame).toContain("[1]");
    expect(frame).toMatch(/low/);
    expect(frame).not.toContain("max"); // unsupported level absent
    await type(inst, "2"); // low
    await vi.waitFor(() => {
      expect(props.onAssign).toHaveBeenCalledWith({
        providerAccount: "acme-main",
        model: "solo",
        thinkingLevel: expect.any(String),
      });
    }, { timeout: 3000 });
  });
});

describe("ModelPicker — Esc semantics + busy", () => {
  it("Esc backs out one level at a time", async () => {
    const { inst, props } = setup({ models: [model("solo", "acme", { reachableVia: ["acme-main"] })] });
    await type(inst, ENTER); // thinking
    await type(inst, ESC);   // back to search
    expect(inst.lastFrame() ?? "").toContain("Search");
    await type(inst, "x");
    await type(inst, ESC);   // clears search
    expect(props.onClose).not.toHaveBeenCalled();
    await type(inst, ESC);   // closes
    expect(props.onClose).toHaveBeenCalled();
  });

  it("ignores input while a save is in flight", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const { inst, props } = setup({
      models: [model("solo", "acme", { reachableVia: ["acme-main"] })],
      onAssign: async () => { await gate; return null; },
    });
    await type(inst, ENTER); // thinking
    inst.stdin.write("1");   // assign → busy (no await: assert mid-flight)
    await delay();
    expect(inst.lastFrame() ?? "").toContain("Saving");
    await type(inst, ESC);   // ignored while busy
    expect(props.onClose).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => {
      expect(inst.lastFrame() ?? "").toContain("assigned");
    });
  });

  it("PageUp / PageDown jumps through rows", async () => {
    const models = Array.from({ length: 25 }, (_, i) => model(`model-${i + 1}`, "acme", { reachableVia: ["acme-main"] }));
    const { inst } = setup({ models });
    await vi.waitFor(() => {
      expect(inst.lastFrame() ?? "").toContain("model 1");
    }, { timeout: 3000 });
    await type(inst, "\u001B[6~"); // PageDown
    await vi.waitFor(() => {
      expect(inst.lastFrame() ?? "").toContain("model 19");
    }, { timeout: 3000 });
    await type(inst, "\u001B[5~"); // PageUp
    await vi.waitFor(() => {
      expect(inst.lastFrame() ?? "").toContain("model 1");
    }, { timeout: 3000 });
  });
});
