/**
 * Tests for messagesToFeedEntries — projects persisted Message[] back into the
 * FeedEntry union on session resume. Pure function, no React/Ink.
 *
 * Uses the REAL persisted shape produced by runAgentLoop: an assistant message
 * whose toolCalls[] carry no `result` (tools haven't run yet at construction),
 * paired with separate role:"tool" messages linked by toolCallId that hold the
 * output. See agent-loop.ts:351-358 (assistant) and :459-465 (tool results).
 */
import { describe, it, expect } from "vitest";
import { messagesToFeedEntries } from "../feed-serializer.js";
import type { Message } from "../../../../core/types.js";

function msg(role: Message["role"], content: string, extra: Partial<Message> = {}): Message {
  return { id: `${role}-${content}`, role, content, timestamp: 0, ...extra };
}

describe("messagesToFeedEntries", () => {
  it("skips system messages", () => {
    const { entries } = messagesToFeedEntries([msg("system", "you are an agent")]);
    expect(entries).toEqual([]);
  });

  it("maps a user message to a user entry", () => {
    const { entries } = messagesToFeedEntries([msg("user", "hello there")]);
    expect(entries).toEqual([{ kind: "user", content: "hello there" }]);
  });

  it("maps assistant text to an assistant entry", () => {
    const { entries } = messagesToFeedEntries([msg("assistant", "hi!")]);
    expect(entries).toEqual([{ kind: "assistant", content: "hi!" }]);
  });

  it("joins tool results from role:tool messages by toolCallId", () => {
    // Real persisted shape: assistant has toolCalls with no result; results
    // live in separate role:"tool" messages linked by toolCallId.
    const messages: Message[] = [
      msg("assistant", "running it", {
        toolCalls: [
          { id: "tc1", name: "read_file", arguments: { path: "/a" } },
          { id: "tc2", name: "execute_shell", arguments: { cmd: "ls" } },
        ],
      }),
      msg("tool", "contents of /a", { toolCallId: "tc1" }),
      msg("tool", "file1\nfile2", { toolCallId: "tc2" }),
    ];
    const { entries } = messagesToFeedEntries(messages);
    expect(entries).toEqual([
      { kind: "assistant", content: "running it" },
      { kind: "tool", name: "read_file", args: { path: "/a" }, status: "ok", output: "contents of /a" },
      { kind: "tool", name: "execute_shell", args: { cmd: "ls" }, status: "ok", output: "file1\nfile2" },
    ]);
  });

  it("marks a tool call as failed when no matching role:tool result exists", () => {
    const messages: Message[] = [
      msg("assistant", "", {
        toolCalls: [{ id: "tc1", name: "boom", arguments: {} }],
      }),
      // No role:"tool" message for tc1 — e.g. the loop was aborted mid-execution.
    ];
    const { entries } = messagesToFeedEntries(messages);
    expect(entries).toEqual([
      { kind: "tool", name: "boom", args: {}, status: "fail", output: undefined },
    ]);
  });

  it("prefers inline tc.result when present (defensive — future backfill)", () => {
    // runAgentLoop doesn't currently set tc.result on the assistant message,
    // but if it ever does, that value should win over the role:tool message.
    const messages: Message[] = [
      msg("assistant", "", {
        toolCalls: [{ id: "tc1", name: "read_file", arguments: {}, result: "inline result" }],
      }),
      msg("tool", "role-tool result", { toolCallId: "tc1" }),
    ];
    const { entries } = messagesToFeedEntries(messages);
    expect(entries[0]).toMatchObject({ output: "inline result", status: "ok" });
  });

  it("preserves order across a full conversation", () => {
    const messages: Message[] = [
      msg("system", "sys"),
      msg("user", "first"),
      msg("assistant", "reply one"),
      msg("user", "second"),
      msg("assistant", "reply two"),
    ];
    const { entries } = messagesToFeedEntries(messages);
    expect(entries.map((e) => e.kind)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(entries.map((e) => ("content" in e ? e.content : ""))).toEqual([
      "first", "reply one", "second", "reply two",
    ]);
  });

  it("routes manage_todos to latestTodos, not the feed (mirrors the live intercept)", () => {
    const messages: Message[] = [
      msg("user", "plan it"),
      msg("assistant", "", {
        toolCalls: [{ id: "tc1", name: "manage_todos", arguments: {}, result: JSON.stringify([{ description: "step 1", status: "pending" }]) }],
      }),
    ];
    const { entries, latestTodos } = messagesToFeedEntries(messages);
    expect(entries).toEqual([{ kind: "user", content: "plan it" }]);
    expect(latestTodos).toEqual([{ description: "step 1", status: "pending" }]);
  });

  it("keeps the most-recent manage_todos as latestTodos", () => {
    const messages: Message[] = [
      msg("assistant", "", { toolCalls: [{ id: "tc1", name: "manage_todos", arguments: {}, result: JSON.stringify([{ description: "old", status: "completed" }]) }] }),
      msg("assistant", "", { toolCalls: [{ id: "tc2", name: "manage_todos", arguments: {}, result: JSON.stringify([{ description: "new", status: "in_progress" }]) }] }),
    ];
    const { latestTodos } = messagesToFeedEntries(messages);
    expect(latestTodos).toEqual([{ description: "new", status: "in_progress" }]);
  });

  it("rebuilds render_widget as a finalized block entry on resume", () => {
    const messages: Message[] = [
      msg("assistant", "", {
        toolCalls: [{
          id: "tc1",
          name: "render_widget",
          arguments: { id: "w1", kind: "table", props: { columns: [], rows: [] } },
          result: "Rendered table widget (w1).",
        }],
      }),
    ];
    const { entries } = messagesToFeedEntries(messages);
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry.kind).toBe("block");
    if (entry.kind === "block") {
      expect(entry.blockKind).toBe("widget");
      expect(entry.finalized).toBe(true);
      expect(entry.props).toMatchObject({ id: "w1", kind: "table" });
    }
  });

  it("renders render_widget as generic tool block when args are malformed", () => {
    const messages: Message[] = [
      msg("assistant", "", {
        toolCalls: [{
          id: "tc1",
          name: "render_widget",
          arguments: { notId: "bad" },
          result: "error",
        }],
      }),
    ];
    const { entries } = messagesToFeedEntries(messages);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("tool"); // falls through to generic block
  });
});
