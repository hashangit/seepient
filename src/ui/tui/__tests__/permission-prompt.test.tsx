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

/** The two-step consent flow: Enter on Scope, then Enter on Duration. */
async function approvePair(stdin: { write: (s: string) => void }, scopeKey?: string, durationKey?: string): Promise<void> {
  if (scopeKey) { stdin.write(scopeKey); await tick(); }
  stdin.write(ENTER);
  await tick();
  if (durationKey) { stdin.write(durationKey); await tick(); }
  stdin.write(ENTER);
  await tick();
}

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
      option("exact", "opt-exact", "Only this file — changes exactly what's shown. Any change will ask again."),
      option("bounded", "opt-bounded", "Other files in this folder — allows other files in this folder during the chosen time."),
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

describe("defaults (FR-011 recommendation)", () => {
  it("recommended scope is the exact option when offered, else the narrowest", () => {
    const opts = request().approvalOptions;
    expect(defaultScopeIndex(opts)).toBe(0);
    expect(defaultScopeIndex([opts[1]])).toBe(0);
    expect(defaultScopeIndex([])).toBe(0);
  });

  it("recommended duration is Just this time when offered, else Until I close Seepient", () => {
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
    const r = request({ approvalOptions: [option("exact", "opt-exact", "Only this file")] });
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
  it("renders only the options supplied by Domain, in plain language", () => {
    const { lastFrame } = renderPrompt();
    const compact = compactFrame(lastFrame()!);
    expect(compact).toContain("only this file");
    expect(compact).toContain("any change will ask again");
    expect(compact).toContain("other files in this folder");
    // No policy jargon, no invented scope kinds.
    expect(compact).not.toContain("[exact]");
    expect(compact).not.toContain("[bounded]");
    expect(compact).not.toContain("exact arguments");
    expect(compact).not.toContain("globally");
    expect(compact).not.toContain("in this project");
  });

  it("shows the action summary and request identity", () => {
    const { lastFrame } = renderPrompt();
    const frame = lastFrame()!;
    expect(frame).toContain("Write file");
    expect(frame).toContain("req-1");
  });

  it("marks the least-privilege defaults as Recommended without selecting them", async () => {
    const { lastFrame, stdin, getCaptured } = renderPrompt();
    const compact = compactFrame(lastFrame()!);
    // Recommended markers exist…
    expect(compact).toMatch(/recommended/);
    // …but nothing is selected yet: Enter on Scope must not approve.
    stdin.write(ENTER);
    await tick();
    expect(getCaptured()).toBeNull();
  });

  it("one option: no additional scope option is created (FR-006)", async () => {
    const r = request({ approvalOptions: [option("exact", "opt-exact", "Only this file — changes exactly what's shown. Any change will ask again.")] });
    const { stdin, lastFrame, getCaptured } = renderPrompt(r);
    const compact = compactFrame(lastFrame()!);
    expect(compact).toContain("only this file");
    expect(compact).not.toContain("other files in this folder");
    expect(compact).not.toContain("globally");
    // Two-step approval with the single option.
    await approvePair(stdin);
    expect(getCaptured()).toEqual({ approved: true, optionId: "opt-exact", lifetime: "action" });
  });

  it("shows the plain-language duration choices with explanations", async () => {
    const { stdin, lastFrame } = renderPrompt();
    stdin.write(TAB);
    await tick();
    const frame = lastFrame()!;
    expect(frame).toContain("Just this time");
    expect(frame).toContain("You'll be asked again next time");
    expect(frame).toContain("Until I close Seepient");
    expect(frame).toContain("Remember this permission for this session");
  });

  it("shows the committed pair in the summary once both are chosen", async () => {
    const { stdin, lastFrame, getCaptured } = renderPrompt();
    await approvePair(stdin);
    expect(getCaptured()).toEqual({ approved: true, optionId: "opt-exact", lifetime: "action" });
    const compact = compactFrame(lastFrame()!);
    expect(compact).toContain("only this file");
    expect(compact).toContain("just this time");
  });
});

// ── Submission and keyboard (T014/T018) ──────────────────────────────────

describe("PermissionPrompt two-step submit + keyboard (T014/T018)", () => {
  it("Enter on Scope does NOT approve — it commits the scope and advances to Duration", async () => {
    const { stdin, getCaptured } = renderPrompt();
    stdin.write(ENTER);
    await tick();
    // Nothing submitted yet — approval stays disabled until BOTH are chosen.
    expect(getCaptured()).toBeNull();
    stdin.write(ENTER);
    await tick();
    expect(getCaptured()).toEqual({ approved: true, optionId: "opt-exact", lifetime: "action" });
  });

  it("Enter on Duration without a committed scope returns to Scope — never submits", async () => {
    const { stdin, getCaptured } = renderPrompt();
    stdin.write(TAB); // jump straight to Duration
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(getCaptured()).toBeNull();
    // We were guided back to the Scope tab: Enter commits + advances, the
    // next Enter on Duration submits.
    stdin.write(ENTER);
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(getCaptured()).toEqual({ approved: true, optionId: "opt-exact", lifetime: "action" });
  });

  it("number keys move focus; the committed pair is what submits", async () => {
    const { stdin, getCaptured } = renderPrompt();
    stdin.write("2"); // focus bounded
    await tick();
    stdin.write(ENTER); // commit bounded, advance
    await tick();
    stdin.write("2"); // focus session
    await tick();
    stdin.write(ENTER); // commit + submit
    await tick();
    expect(getCaptured()).toEqual({ approved: true, optionId: "opt-bounded", lifetime: "session" });
  });

  it("unsupported numbers do nothing", async () => {
    const { stdin, getCaptured } = renderPrompt();
    stdin.write("9");
    await tick();
    expect(getCaptured()).toBeNull();
    stdin.write(ENTER);
    await tick();
    stdin.write(ENTER);
    await tick();
    // Still the recommended pair — the unsupported key changed nothing.
    expect(getCaptured()).toEqual({ approved: true, optionId: "opt-exact", lifetime: "action" });
  });

  it("unsupported keys do nothing", async () => {
    const { stdin, getCaptured } = renderPrompt();
    stdin.write("x");
    await tick();
    expect(getCaptured()).toBeNull();
    stdin.write(ENTER);
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(getCaptured()).toEqual({ approved: true, optionId: "opt-exact", lifetime: "action" });
  });

  it("Tab switches to the Duration tab and back without changing the selection", async () => {
    const { stdin, getCaptured } = renderPrompt();
    stdin.write(TAB);
    await tick();
    stdin.write(TAB);
    await tick();
    stdin.write(ENTER);
    await tick();
    stdin.write(ENTER);
    await tick();
    // Switching tabs never changed the committed values (US2.1).
    expect(getCaptured()).toEqual({ approved: true, optionId: "opt-exact", lifetime: "action" });
  });

  it("q denies without executing", () => {
    const { stdin, getCaptured } = renderPrompt();
    stdin.write("q");
    expect(getCaptured()).toEqual({ approved: false, reason: "user-denied" });
  });

  it("Escape denies without executing", () => {
    const { stdin, getCaptured } = renderPrompt();
    stdin.write("\u001B");
    expect(getCaptured()).toEqual({ approved: false, reason: "user-denied" });
  });

  it("Left/Right switch tabs without changing either committed value (FR-014)", async () => {
    const { stdin, getCaptured } = renderPrompt();
    stdin.write("\u001B[C"); // right → Duration
    await tick();
    stdin.write("2"); // focus session
    await tick();
    stdin.write("\u001B[D"); // left → Scope
    await tick();
    stdin.write("2"); // focus bounded
    await tick();
    stdin.write(ENTER); // commit bounded, advance to Duration
    await tick();
    stdin.write(ENTER); // commit session + submit
    await tick();
    expect(getCaptured()).toEqual({ approved: true, optionId: "opt-bounded", lifetime: "session" });
  });

  it("Shift+Tab switches tabs (FR-014)", async () => {
    const { stdin, getCaptured } = renderPrompt();
    stdin.write("\u001B[Z"); // shift-tab → Duration
    await tick();
    stdin.write("\u001B[D"); // left → Scope
    await tick();
    stdin.write(ENTER); // commit scope → advances to Duration
    await tick();
    stdin.write(ENTER); // commit duration + submit
    await tick();
    expect(getCaptured()).toEqual({ approved: true, optionId: "opt-exact", lifetime: "action" });
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
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(getCaptured()).toEqual({ approved: true, optionId: "opt-exact", lifetime: "action" });
  });

  it("a duration the selected option does not support is never offered", async () => {
    const r = request({
      approvalOptions: [option("exact", "opt-exact", "Only this file", ["action"])],
    });
    const { stdin, lastFrame, getCaptured } = renderPrompt(r);
    stdin.write(TAB);
    await tick();
    const frame = lastFrame()!;
    expect(frame).toContain("Just this time");
    expect(frame).not.toContain("Until I close Seepient");
    stdin.write("\u001B[D"); // left → Scope
    await tick();
    stdin.write(ENTER); // commit scope → advances to Duration
    await tick();
    stdin.write(ENTER); // commit duration + submit
    await tick();
    expect(getCaptured()).toEqual({ approved: true, optionId: "opt-exact", lifetime: "action" });
  });
});
