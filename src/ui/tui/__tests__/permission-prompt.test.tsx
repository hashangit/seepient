import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { PermissionPrompt, commitDecision, cycleSelection } from "../components/permission-prompt.js";
import type { ApprovalContext, ApprovalDecision } from "../../../foundations/types.js";

// Helper: capture the decision passed to onResolve.
function renderPrompt(props: Partial<Parameters<typeof PermissionPrompt>[0]> = {}) {
  let captured: ApprovalDecision | null = null;
  const r = render(
    <PermissionPrompt
      toolName="execute_shell_command"
      args={{ command: "npm test" }}
      onResolve={(d) => { captured = d; }}
      {...props}
    />,
  );
  return { ...r, getCaptured: () => captured };
}

const ENTER = "\r";

// ── Pure logic (arrow keys can't be driven via ink-testing-library, so the
//    selection-cycling and decision-mapping logic is unit-tested directly) ──

describe("commitDecision", () => {
  it("index 0 (once) → true", () => {
    expect(commitDecision(0)).toBe(true);
  });
  it("index 1 (session) → scoped object", () => {
    expect(commitDecision(1)).toEqual({ approved: true, scope: "session" });
  });
  it("index 2 (project) → scoped object", () => {
    expect(commitDecision(2)).toEqual({ approved: true, scope: "project" });
  });
  it("index 3 (global) → scoped object", () => {
    expect(commitDecision(3)).toEqual({ approved: true, scope: "global" });
  });
  it("index 4 (deny) → false", () => {
    expect(commitDecision(4)).toBe(false);
  });
  it("out-of-range index → false (deny)", () => {
    expect(commitDecision(99)).toBe(false);
  });
});

describe("cycleSelection", () => {
  it("down from 0 → 1", () => { expect(cycleSelection(0, 1)).toBe(1); });
  it("down from 4 wraps → 0", () => { expect(cycleSelection(4, 1)).toBe(0); });
  it("up from 0 wraps → 4", () => { expect(cycleSelection(0, -1)).toBe(4); });
  it("up from 3 → 2", () => { expect(cycleSelection(3, -1)).toBe(2); });
});

// ── Rendering + quick-select / Enter (single-byte inputs work in the test harness) ──

describe("PermissionPrompt rendering", () => {
  it("renders the LLM title and description", () => {
    const ctx: ApprovalContext = {
      title: "Run test suite",
      description: "Verifies the build passes before committing.",
    };
    const { lastFrame } = renderPrompt({ approvalContext: ctx });
    const frame = lastFrame()!;
    expect(frame).toContain("Run test suite");
    expect(frame).toContain("Verifies the build passes before committing.");
  });

  it("shows the actual command (tamper-proof)", () => {
    const { lastFrame } = renderPrompt();
    expect(lastFrame()!).toContain("npm test");
  });

  it("renders all five options with pattern-aware labels", () => {
    const { lastFrame } = renderPrompt();
    const frame = lastFrame()!;
    // Assert on scope keywords + the pattern rather than exact copy, so the
    // test survives wording edits. Labels wrap across box borders in the
    // narrow test renderer, so "This Session" may be split across lines —
    // use case-insensitive, whitespace-insensitive matching on fragments.
    const compact = frame.toLowerCase().replace(/\s+/g, ' ');
    expect(compact).toContain("allow");
    expect(compact).toContain("once");
    expect(compact).toContain("session");
    expect(compact).toContain("project");
    expect(compact).toContain("globally");
    expect(compact).toContain("deny");
    expect(compact).toContain("npm test");   // pattern appears in labels
  });

  it("tool without a pattern shows generic wording in labels", () => {
    const { lastFrame } = renderPrompt({
      toolName: "web_search",
      args: { query: "x" },
    });
    const frame = lastFrame()!;
    // No command/path → no extracted pattern; label uses a generic noun.
    // Match case/whitespace-insensitively (label may wrap across borders).
    const compact = frame.toLowerCase().replace(/\s+/g, ' ');
    expect(compact).toContain("session");
    // Should NOT claim a specific command it doesn't have
    expect(compact).not.toContain("\"npm test\"");
  });

  it("falls back to template implications when LLM omitted them", () => {
    const { lastFrame } = renderPrompt({
      approvalContext: { title: "T", description: "D" }, // no implications
    });
    const frame = lastFrame()!;
    // Template implications mention the session/global semantics.
    const compact = frame.toLowerCase().replace(/\s+/g, ' ');
    expect(compact).toMatch(/restart|session|until/);  // session template
    expect(compact).toMatch(/revoke|permissions|everywhere|trust/); // global template
  });

  it("uses LLM-authored implications when provided", () => {
    const { lastFrame } = renderPrompt({
      approvalContext: {
        title: "T",
        description: "D",
        implications: { session: "custom session implication text xyz", project: "p", global: "g" },
      },
    });
    expect(lastFrame()!).toContain("custom session implication text xyz");
  });
});

describe("PermissionPrompt quick-select + enter", () => {
  it("Enter on default selection (Allow once) resolves true", () => {
    const { stdin, getCaptured } = renderPrompt();
    stdin.write(ENTER);
    expect(getCaptured()).toBe(true);
  });

  it("quick-select 1 → true (once)", () => {
    const { stdin, getCaptured } = renderPrompt();
    stdin.write("1");
    expect(getCaptured()).toBe(true);
  });

  it("quick-select 2 → session scope", () => {
    const { stdin, getCaptured } = renderPrompt();
    stdin.write("2");
    expect(getCaptured()).toEqual({ approved: true, scope: "session" });
  });

  it("quick-select 3 → project scope", () => {
    const { stdin, getCaptured } = renderPrompt();
    stdin.write("3");
    expect(getCaptured()).toEqual({ approved: true, scope: "project" });
  });

  it("quick-select 4 → global scope", () => {
    const { stdin, getCaptured } = renderPrompt();
    stdin.write("4");
    expect(getCaptured()).toEqual({ approved: true, scope: "global" });
  });

  it("quick-select 5 → deny (false)", () => {
    const { stdin, getCaptured } = renderPrompt();
    stdin.write("5");
    expect(getCaptured()).toBe(false);
  });
});
