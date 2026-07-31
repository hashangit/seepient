/**
 * Tests for session-export formatters — pure functions over SessionData.
 */
import { describe, it, expect } from "vitest";
import { formatJson, formatTranscript } from "../session-export.js";
import type { SessionData } from "../../../foundations/types.js";

function makeSession(overrides: Partial<SessionData> = {}): SessionData {
  return {
    id: "abc-12345",
    messages: [
      { id: "s1", role: "system", content: "sys", timestamp: 1000 },
      { id: "u1", role: "user", content: "hello there", timestamp: 2000 },
      { id: "a1", role: "assistant", content: "hi back", timestamp: 3000, toolCalls: [
        { id: "tc1", name: "read_file", arguments: { path: "/a" } },
      ] },
      { id: "t1", role: "tool", content: "file contents", toolCallId: "tc1", timestamp: 3500 },
    ],
    createdAt: 1000,
    updatedAt: 4000,
    provider: "anthropic",
    model: "claude-3.5",
    ...overrides,
  };
}

describe("formatJson", () => {
  it("produces valid JSON with all fields", () => {
    const session = makeSession();
    const json = formatJson(session);
    const parsed = JSON.parse(json);
    expect(parsed.id).toBe("abc-12345");
    expect(parsed.messages).toHaveLength(4);
    expect(parsed.provider).toBe("anthropic");
    expect(parsed.model).toBe("claude-3.5");
  });
});

describe("formatTranscript", () => {
  it("renders a human-readable markdown transcript", () => {
    const session = makeSession();
    const md = formatTranscript(session);
    expect(md).toContain("# Session abc-1234");
    expect(md).toContain("## User");
    expect(md).toContain("hello there");
    expect(md).toContain("## Assistant");
    expect(md).toContain("hi back");
    expect(md).toContain("### Tool: read_file");
    expect(md).toContain("file contents");
  });

  it("joins tool results from role:tool messages by toolCallId", () => {
    const session = makeSession();
    const md = formatTranscript(session);
    // The result from the role:"tool" message should appear in the tool section.
    expect(md).toContain("**Result:**");
    expect(md).toContain("file contents");
  });

  it("skips system messages", () => {
    const session = makeSession();
    const md = formatTranscript(session);
    expect(md).not.toContain("## System");
    expect(md).not.toContain("sys");
  });

  it("includes provider and model headers when present", () => {
    const session = makeSession();
    const md = formatTranscript(session);
    expect(md).toContain("Provider: anthropic");
    expect(md).toContain("Model: claude-3.5");
  });

  it("omits provider/model headers when absent", () => {
    const session = makeSession({ provider: undefined, model: undefined });
    const md = formatTranscript(session);
    expect(md).not.toContain("Provider:");
    expect(md).not.toContain("Model:");
  });
});
