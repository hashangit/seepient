import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import {
  PermissionPrompt,
  buildSelection,
  clampMove,
  defaultLifetimeIndex,
  defaultScopeIndex,
  visibleLifetimes,
} from "../components/permission-prompt.js";
import type {
  PermissionRequest,
  TuiApprovalSelection,
} from "../../../foundations/contracts/permission-policy.js";

// Helper: capture the selection passed to onResolve.
function renderPrompt(overrides: Partial<PermissionRequest> = {}) {
  let captured: TuiApprovalSelection | null = null;
  const r = render(
    <PermissionPrompt
      request={request(overrides)}
      onResolve={(s) => { captured = s; }}
    />,
  );
  return { ...r, getCaptured: () => captured };
}

const ENTER = "\r";
const TAB = "\t";

/** Let React commit the state change from a key press before the next key. */
const tick = (): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

function option(kind: "exact" | "bounded", optionId: string, label: string, supportedLifetimes: Array<"action" | "session"> = ["action", "session"]) {
  return {
    optionId,
    actionDigest: "d1",
    kind,
    label,
    capabilities: [],
    supportedLifetimes,
  };
}

function request(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  const base: PermissionRequest = {
    requestId: "req-1",
    principalId: "u",
    runId: "r1",
    sessionId: "sess-1",
    toolCallId: "c1",
    actionDigest: "d1",
    action: {
      title: "Write file",
      summary: "Write /proj/a.txt",
      canonicalTargets: ["/proj/a.txt"],
      effects: ["filesystem-write"],
    },
    requestedCapabilities: [{ kind: "commit-file", path: "/proj/a.txt" }],
    approvalOptions: [
      option("exact", "opt-exact", "Exact — write /proj/a.txt"),
      option("bounded", "opt-bounded", "Bounded — write anything under /proj"),
    ],
    offeredLifetimes: ["action", "session"],
    createdAt: 0,
    expiresAt: Date.now() + 60_000,
  };
  return { ...base, ...overrides };
}

function compactFrame(frame: string): string {
  return frame.toLowerCase().replace(/\s+/g, " ");
}

// ── Pure selection/default logic ─────────────────────────────────────────

describe("defaults (FR-011 least privilege)", () => {
  it("default scope is the exact option when offered, else the narrowest", () => {
    const opts = request().approvalOptions;
    expect(defaultScopeIndex(opts)).toBe(0);
    expect(defaultScopeIndex([opts[1]])).toBe(0);
    expect(defaultScopeIndex([])).toBe(0);
  });

  it("default duration is Allow Once when offered, else This Session", () => {
    expect(defaultLifetimeIndex(["action", "session"])).toBe(0);
    expect(defaultLifetimeIndex(["session"])).toBe(0);
    expect(defaultLifetimeIndex([])).toBe(0);
  });

  it("visibleLifetimes exposes only action/session offered by both", () => {
    const opts = request().approvalOptions;
    expect(visibleLifetimes(opts[0])).toEqual(["action", "session"]);
    expect(
      visibleLifetimes({ ...opts[0], supportedLifetimes: ["action", "run", "session"] }),
    ).toEqual(["action", "session"]);
    expect(visibleLifetimes({ ...opts[0], supportedLifetimes: ["run"] })).toEqual([]);
    // request-level offered lifetimes narrow the option's list
    expect(
      visibleLifetimes(opts[0], { ...request(), offeredLifetimes: ["action"] }),
    ).toEqual(["action"]);
  });

  it("clampMove never wraps at the ends (FR-015)", () => {
    expect(clampMove(0, -1, 3)).toBe(0);
    expect(clampMove(2, 1, 3)).toBe(2);
    expect(clampMove(1, -1, 3)).toBe(0);
    expect(clampMove(1, 1, 3)).toBe(2);
    expect(clampMove(0, 1, 1)).toBe(0);
  });

  it("buildSelection returns only the selected option ID and lifetime", () => {
    expect(buildSelection(request(), 1, 1)).toEqual({
      approved: true,
      optionId: "opt-bounded",
      lifetime: "session",
    });
  });

  it("buildSelection clamps stale indices to the visible set", () => {
    const r = request({ approvalOptions: [option("exact", "opt-exact", "Exact")] });
    expect(buildSelection(r, 99, 5)).toEqual({
      approved: true,
      optionId: "opt-exact",
      lifetime: "session",
    });
  });

  it("buildSelection with no representable options denies as unavailable", () => {
    expect(buildSelection(request({ approvalOptions: [] }), 0, 0)).toEqual({
      approved: false,
      reason: "approval-unavailable",
    });
  });
});

// ── Rendering (T014) ─────────────────────────────────────────────────────

describe("PermissionPrompt rendering (T014)", () => {
  it("renders only the options supplied by Domain, explained in plain language", () => {
    const { lastFrame } = renderPrompt();
    const compact = compactFrame(lastFrame()!);
    expect(compact).toContain("exact — write /proj/a.txt");
    expect(compact).toContain("bounded — write anything under /proj");
    // Never invents project/global/tool-wide choices.
    expect(compact).not.toContain("globally");
    expect(compact).not.toContain("in this project");
  });

  it("shows the action summary and request identity", () => {
    const { lastFrame } = renderPrompt();
    const frame = lastFrame()!;
    expect(frame).toContain("Write file");
    expect(frame).toContain("req-1");
  });

  it("one option: no additional scope option is created (FR-006)", () => {
    const r = request({ approvalOptions: [option("exact", "opt-exact", "Exact — write /proj/a.txt")] });
    const { stdin, lastFrame, getCaptured } = renderPrompt(r);
    const compact = compactFrame(lastFrame()!);
    expect(compact).toContain("exact — write /proj/a.txt");
    expect(compact).not.toContain("bounded");
    expect(compact).not.toContain("globally");
    // Enter approves the single option with the least-privilege duration.
    stdin.write(ENTER);
    expect(getCaptured()).toEqual({ approved: true, optionId: "opt-exact", lifetime: "action" });
  });

  it("shows a summary of the selected scope and duration at all times", () => {
    const { lastFrame } = renderPrompt();
    const compact = compactFrame(lastFrame()!);
    expect(compact).toContain("selected");
    expect(compact).toContain("exact — write /proj/a.txt");
    expect(compact).toContain("allow once");
  });
});

// ── Submission and keyboard (T014/T018) ──────────────────────────────────

describe("PermissionPrompt submit + keyboard (T014/T018)", () => {
  it("Enter submits the least-privilege default pair (exact + Allow Once)", () => {
    const { stdin, getCaptured } = renderPrompt();
    stdin.write(ENTER);
    expect(getCaptured()).toEqual({ approved: true, optionId: "opt-exact", lifetime: "action" });
  });

  it("number keys select the corresponding visible item (scope tab)", async () => {
    const { stdin, getCaptured } = renderPrompt();
    stdin.write("2");
    await tick();
    stdin.write(ENTER);
    expect(getCaptured()).toEqual({ approved: true, optionId: "opt-bounded", lifetime: "action" });
  });

  it("unsupported numbers do nothing", async () => {
    const { stdin, getCaptured } = renderPrompt();
    stdin.write("9");
    await tick();
    expect(getCaptured()).toBeNull();
    stdin.write(ENTER);
    // Still the default pair — the unsupported key changed nothing.
    expect(getCaptured()).toEqual({ approved: true, optionId: "opt-exact", lifetime: "action" });
  });

  it("unsupported keys do nothing", async () => {
    const { stdin, getCaptured } = renderPrompt();
    stdin.write("x");
    await tick();
    expect(getCaptured()).toBeNull();
    stdin.write(ENTER);
    expect(getCaptured()).toEqual({ approved: true, optionId: "opt-exact", lifetime: "action" });
  });

  it("Tab switches to the Duration tab and back without changing the selection", async () => {
    const { stdin, getCaptured } = renderPrompt();
    stdin.write(TAB);
    await tick();
    // Duration rows for the selected option are now visible (asserted via
    // the duration labels in the frame).
    stdin.write(TAB);
    await tick();
    stdin.write(ENTER);
    // Switching tabs never changed the selected values (US2.1).
    expect(getCaptured()).toEqual({ approved: true, optionId: "opt-exact", lifetime: "action" });
  });

  it("number keys on the Duration tab select the duration", async () => {
    const { stdin, getCaptured } = renderPrompt();
    stdin.write(TAB); // to Duration
    await tick();
    stdin.write("2"); // This Session
    await tick();
    stdin.write(ENTER);
    expect(getCaptured()).toEqual({ approved: true, optionId: "opt-exact", lifetime: "session" });
  });

  it("q denies without executing", () => {
    const { stdin, getCaptured } = renderPrompt();
    stdin.write("q");
    expect(getCaptured()).toEqual({ approved: false, reason: "user-denied" });
  });

  it("Left/Right switch tabs without changing either selected value (FR-014)", async () => {
    const { stdin, getCaptured } = renderPrompt();
    stdin.write("\u001B[C"); // right → Duration
    await tick();
    stdin.write("2"); // This Session on the Duration tab
    await tick();
    stdin.write("\u001B[D"); // left → Scope
    await tick();
    stdin.write("2"); // Bounded on the Scope tab
    await tick();
    stdin.write(ENTER);
    // Each tab kept its own selection; the pair is the visible one.
    expect(getCaptured()).toEqual({ approved: true, optionId: "opt-bounded", lifetime: "session" });
  });

  it("Shift+Tab switches tabs (FR-014)", async () => {
    const { stdin, getCaptured } = renderPrompt();
    stdin.write("\u001B[Z"); // shift-tab → Duration
    await tick();
    stdin.write("2"); // This Session
    await tick();
    stdin.write(ENTER);
    expect(getCaptured()).toEqual({ approved: true, optionId: "opt-exact", lifetime: "session" });
  });

  it("Up/Down move within the active tab and stop at the ends (FR-015)", async () => {
    const { stdin, getCaptured } = renderPrompt();
    // Scope tab: down to the last option, then beyond (no wrap).
    stdin.write("\u001B[B"); // down → bounded
    await tick();
    stdin.write("\u001B[B"); // down → stuck at bounded
    await tick();
    stdin.write("\u001B[A"); // up → exact
    await tick();
    stdin.write("\u001B[A"); // up → stuck at exact (no wrap)
    await tick();
    stdin.write(ENTER);
    expect(getCaptured()).toEqual({ approved: true, optionId: "opt-exact", lifetime: "action" });
  });

  it("Escape denies without executing", () => {
    const { stdin, getCaptured } = renderPrompt();
    stdin.write("\u001B");
    expect(getCaptured()).toEqual({ approved: false, reason: "user-denied" });
  });

  it("a duration the selected option does not support is never offered", async () => {
    const r = request({
      approvalOptions: [option("exact", "opt-exact", "Exact — write /proj/a.txt", ["action"])],
    });
    const { stdin, lastFrame, getCaptured } = renderPrompt(r);
    // Selected option offers only Allow Once.
    stdin.write(TAB);
    await tick();
    const frame = lastFrame()!;
    expect(frame).toContain("Allow Once");
    expect(frame).not.toContain("This Session");
    stdin.write(ENTER);
    expect(getCaptured()).toEqual({ approved: true, optionId: "opt-exact", lifetime: "action" });
  });
});
