import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { PermissionPrompt, clampMove } from "../components/permission-prompt.js";
import { useKeybindings } from "../hooks/use-keybindings.js";
import type {
  ApprovalChoice,
  ApprovalOption,
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

/** Let React commit the state change from a key press before the next key. */
const tick = (): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

function option(kind: "exact" | "bounded", optionId: string, caps: Array<{ kind: "read-root"; root: string } | { kind: "read-file"; path: string } | { kind: "process"; executable: string; argvPrefix?: string[] }>, supportedLifetimes: Array<"action" | "session"> = ["action", "session"]): ApprovalOption {
  return {
    optionId,
    actionDigest: "d1",
    kind,
    label: `${kind} option`,
    capabilities: caps,
    supportedLifetimes,
  };
}

function choice(optionId: string, lifetime: "action" | "session", title: string, authoritySummary: string[], recommended = false): ApprovalChoice {
  return {
    choiceId: `${optionId}::${lifetime}`,
    optionId,
    lifetime,
    title,
    description:
      lifetime === "action"
        ? "You'll be asked again next time."
        : "Seepient will remember this permission until you close it.",
    authoritySummary,
    recommended,
  };
}

const EXACT_CAPS = [{ kind: "read-file" as const, path: "/proj/a.txt" }];
const BOUNDED_CAPS = [{ kind: "read-root" as const, root: "/proj" }];

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
    requestedCapabilities: EXACT_CAPS,
    approvalOptions: [
      option("exact", "opt-exact", EXACT_CAPS),
      option("bounded", "opt-bounded", BOUNDED_CAPS),
    ],
    approvalChoices: [
      choice("opt-exact", "action", "Allow this action once", ["Read `/proj/a.txt`"], true),
      choice("opt-exact", "session", "Allow this exact action until I close Seepient", ["Read `/proj/a.txt`"]),
      choice("opt-bounded", "session", "Allow other files in this folder until I close Seepient", ["Read files under `/proj`"]),
    ],
    offeredLifetimes: ["action", "run", "session"],
    createdAt: 0,
    expiresAt: Date.now() + 60_000,
  };
  return { ...base, ...overrides };
}

function compactFrame(frame: string): string {
  return frame.toLowerCase().replace(/\s+/g, " ");
}

// ── Pure helpers ────────────────────────────────────────────────────────

describe("clampMove (FR-014)", () => {
  it("never wraps at the ends", () => {
    expect(clampMove(0, -1, 3)).toBe(0);
    expect(clampMove(2, 1, 3)).toBe(2);
    expect(clampMove(1, -1, 3)).toBe(0);
    expect(clampMove(1, 1, 3)).toBe(2);
    expect(clampMove(0, 1, 1)).toBe(0);
  });
});

// ── Rendering (T028/T029) ───────────────────────────────────────────────

describe("PermissionPrompt rendering (T028)", () => {
  it("shows one screen of complete Domain choices — no tabs, no pairs", () => {
    const { lastFrame } = renderPrompt();
    const compact = compactFrame(lastFrame()!);
    expect(compact).toContain("permission needed");
    expect(compact).toContain("write file");
    expect(compact).toContain("allow this action once");
    // Rows wrap at terminal width; assert wrap-stable title prefixes.
    expect(compact).toContain("allow this exact action until i close");
    expect(compact).toContain("allow other files in this folder until i");
    // No scope/duration matrix, no invented choices.
    expect(compact).not.toContain("[1] scope");
    expect(compact).not.toContain("duration");
    expect(compact).not.toContain("bounded/action");
    expect(compact).not.toContain("exact arguments");
    // Domain labels are not the consent copy; choice titles are.
    expect(compact).not.toContain("exact option");
  });

  it("marks the least-privilege choice Recommended without pre-approving", () => {
    const { lastFrame } = renderPrompt();
    const compact = compactFrame(lastFrame()!);
    expect(compact).toContain("(recommended)");
    // The recommendation sits on the exact/action row.
    const actionIdx = compact.indexOf("allow this action once");
    const recommendedIdx = compact.indexOf("(recommended)");
    expect(recommendedIdx).toBeGreaterThan(actionIdx);
    expect(recommendedIdx).toBeLessThan(compact.indexOf("allow this exact action until i close"));
  });

  it("shows the authority delta of the focused choice (FR-016)", () => {
    const { stdin, lastFrame } = renderPrompt();
    stdin.write("\u001B[B"); // down → exact/session
    return tick().then(() => {
      const frame = lastFrame()!;
      expect(frame).toContain("Read `/proj/a.txt`");
      expect(frame).toContain("Seepient will remember this permission until you close it.");
    });
  });

  it("shows the request identity and expiry", () => {
    const { lastFrame } = renderPrompt();
    const frame = lastFrame()!;
    expect(frame).toContain("req-1");
    expect(frame).toMatch(/expires/);
  });

  it("renders only the choices the request carries", () => {
    const r = request({
      approvalChoices: [
        choice("opt-exact", "action", "Allow this action once", ["Read `/proj/a.txt`"], true),
      ],
    });
    const { lastFrame } = renderPrompt(r);
    const compact = compactFrame(lastFrame()!);
    expect(compact).toContain("allow this action once");
    expect(compact).not.toContain("until i close seepient");
    expect(compact).not.toContain("other files in this folder");
  });

  it("a request with no choices denies as unavailable immediately", async () => {
    const { getCaptured } = renderPrompt({ approvalChoices: [] });
    await tick();
    expect(getCaptured()).toEqual({ approved: false, reason: "approval-unavailable" });
  });
});

// ── Submission and keyboard (T028/T029) ─────────────────────────────────

describe("PermissionPrompt submission + keyboard (T028)", () => {
  it("one Enter approves the focused (recommended) choice — no second step", async () => {
    const { stdin, getCaptured } = renderPrompt();
    stdin.write(ENTER);
    await tick();
    expect(getCaptured()).toEqual({ approved: true, choiceId: "opt-exact::action" });
  });

  it("focus starts on the Recommended choice wherever Domain placed it (FR-011)", async () => {
    // Recommended is NOT first here — initial focus must find it, not
    // assume index 0.
    const req = request({
      approvalChoices: [
        choice("opt-exact", "session", "Allow this exact action until I close Seepient", ["Read `/proj/a.txt`"]),
        choice("opt-exact", "action", "Allow this action once", ["Read `/proj/a.txt`"], true),
      ],
    });
    let captured: TuiApprovalSelection | null = null;
    const { stdin } = render(
      <PermissionPrompt request={req} onResolve={(s) => { captured = s; }} />,
    );
    stdin.write(ENTER);
    await tick();
    expect(captured).toEqual({ approved: true, choiceId: "opt-exact::action" });
  });

  it("Enter approves whatever choice is focused", async () => {
    const { stdin, getCaptured } = renderPrompt();
    stdin.write("2");
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(getCaptured()).toEqual({ approved: true, choiceId: "opt-exact::session" });
    const { stdin: s2, getCaptured: g2 } = renderPrompt();
    s2.write("\u001B[B"); // down → exact/session
    await tick();
    s2.write("\u001B[B"); // down → bounded/session
    await tick();
    s2.write(ENTER);
    await tick();
    expect(g2()).toEqual({ approved: true, choiceId: "opt-bounded::session" });
  });

  it("Up/Down move without wrapping past the ends (FR-014)", async () => {
    const { stdin, getCaptured } = renderPrompt();
    stdin.write("\u001B[A"); // up at the top → stays
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(getCaptured()).toEqual({ approved: true, choiceId: "opt-exact::action" });
    const { stdin: s2, getCaptured: g2 } = renderPrompt();
    s2.write("\u001B[B"); // down → exact/session
    await tick();
    s2.write("\u001B[B"); // down → bounded/session
    await tick();
    s2.write("\u001B[B"); // down at the bottom → stays
    await tick();
    s2.write(ENTER);
    await tick();
    expect(g2()).toEqual({ approved: true, choiceId: "opt-bounded::session" });
  });

  it("unsupported numbers do nothing (FR-014)", async () => {
    const { stdin, getCaptured } = renderPrompt();
    stdin.write("9");
    await tick();
    stdin.write("0");
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(getCaptured()).toEqual({ approved: true, choiceId: "opt-exact::action" });
  });

  it("unsupported keys do nothing", async () => {
    const { stdin, getCaptured } = renderPrompt();
    stdin.write("x");
    await tick();
    stdin.write("\t");
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(getCaptured()).toEqual({ approved: true, choiceId: "opt-exact::action" });
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

  it("one prompt resolves at most once — late keys after Enter are ignored", async () => {
    const { stdin, getCaptured } = renderPrompt();
    stdin.write(ENTER);
    await tick();
    stdin.write("q");
    await tick();
    expect(getCaptured()).toEqual({ approved: true, choiceId: "opt-exact::action" });
  });
});

// ── Global-keybinding interplay (FR-015 regression) ─────────────────────
//
// app.tsx passes promptPending to useKeybindings while the native prompt is
// open. This mounts BOTH input subscribers the way app.tsx does, proving an
// Escape denies the request without also aborting the run — while Ctrl+C
// remains the hard abort.

describe("permission prompt vs global keybindings (FR-015)", () => {
  it("Escape denies the prompt and does NOT abort the run", async () => {
    let captured: TuiApprovalSelection | null = null;
    const events: string[] = [];
    function Harness() {
      useKeybindings(
        {
          onAbort: () => events.push("abort"),
          onExit: () => events.push("exit"),
          onClearDraft: () => events.push("clear-draft"),
          onExpandToggle: () => {},
          onPalette: () => {},
          onClear: () => {},
        },
        { enabled: true, isRunning: true, promptPending: true, hasDraft: false },
      );
      return <PermissionPrompt request={request()} onResolve={(s) => { captured = s; }} />;
    }
    const { stdin } = render(<Harness />);
    stdin.write("\u001B");
    await tick();
    expect(captured).toEqual({ approved: false, reason: "user-denied" });
    expect(events).toEqual([]);
  });

  it("Ctrl+C still aborts the run while the prompt is open", async () => {
    const events: string[] = [];
    function Harness() {
      useKeybindings(
        {
          onAbort: () => events.push("abort"),
          onExit: () => events.push("exit"),
          onClearDraft: () => events.push("clear-draft"),
          onExpandToggle: () => {},
          onPalette: () => {},
          onClear: () => {},
        },
        { enabled: true, isRunning: true, promptPending: true, hasDraft: false },
      );
      return <PermissionPrompt request={request()} onResolve={() => {}} />;
    }
    const { stdin } = render(<Harness />);
    stdin.write("\x03");
    await tick();
    expect(events).toEqual(["abort"]);
  });

  it("Escape aborts as usual when no prompt is pending", async () => {
    const events: string[] = [];
    function Harness() {
      useKeybindings(
        {
          onAbort: () => events.push("abort"),
          onExit: () => events.push("exit"),
          onClearDraft: () => events.push("clear-draft"),
          onExpandToggle: () => {},
          onPalette: () => {},
          onClear: () => {},
        },
        { enabled: true, isRunning: true, hasDraft: false },
      );
      return null;
    }
    const { stdin } = render(<Harness />);
    stdin.write("\u001B");
    await tick();
    expect(events).toEqual(["abort"]);
  });
});

