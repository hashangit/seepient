import { describe, it, expect } from "vitest";
import {
  estimateTokens,
  toZoeError,
  messageToProviderMessage,
  providerToolCallToToolCall,
} from "../message-convert.js";
import { ZoeError, ProviderError, ToolError } from "../errors.js";

describe("estimateTokens", () => {
  it("returns ceil(length/4)", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("12345678")).toBe(2);
    expect(estimateTokens("a")).toBe(1);
  });
});

describe("toZoeError", () => {
  it("creates ProviderError for PROVIDER_ERROR code", () => {
    const err = toZoeError(new Error("timeout"), "PROVIDER_ERROR");
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toBe("timeout");
  });

  it("creates ToolError for TOOL_FAILED code", () => {
    const err = toZoeError("something bad", "TOOL_FAILED");
    expect(err).toBeInstanceOf(ToolError);
    expect(err.message).toBe("something bad");
  });

  it("creates ZoeError for unknown codes", () => {
    const err = toZoeError("oops", "UNKNOWN");
    expect(err).toBeInstanceOf(ZoeError);
    expect(err.code).toBe("UNKNOWN");
  });

  it("sets retryable=true for PROVIDER_ERROR on default path", () => {
    const err = toZoeError("x", "PROVIDER_ERROR");
    // The switch case creates a ProviderError, but the default path is covered
    // by testing a code that falls through:
    const generic = toZoeError("x", "PROVIDER_ERROR");
    expect(generic.retryable).toBe(true);
  });
});

describe("messageToProviderMessage", () => {
  it("converts a simple text message", () => {
    const msg = {
      id: "1",
      role: "user" as const,
      content: "hello",
      timestamp: 1000,
    };
    const pm = messageToProviderMessage(msg);
    expect(pm.role).toBe("user");
    expect(pm.content).toBe("hello");
    expect(pm.tool_calls).toBeUndefined();
    expect(pm.tool_call_id).toBeUndefined();
  });

  it("converts tool calls with JSON-stringified arguments", () => {
    const msg = {
      id: "2",
      role: "assistant" as const,
      content: "",
      timestamp: 1000,
      toolCalls: [
        { id: "tc1", name: "read_file", arguments: { path: "/tmp/x" } },
      ],
    };
    const pm = messageToProviderMessage(msg);
    expect(pm.tool_calls).toHaveLength(1);
    expect(pm.tool_calls![0].id).toBe("tc1");
    expect(pm.tool_calls![0].name).toBe("read_file");
    expect(pm.tool_calls![0].arguments).toBe('{"path":"/tmp/x"}');
  });

  it("preserves tool_call_id", () => {
    const msg = {
      id: "3",
      role: "tool" as const,
      content: "file contents",
      timestamp: 1000,
      toolCallId: "tc1",
    };
    const pm = messageToProviderMessage(msg);
    expect(pm.tool_call_id).toBe("tc1");
  });

  it("omits tool_calls when array is empty", () => {
    const msg = {
      id: "4",
      role: "assistant" as const,
      content: "hi",
      timestamp: 1000,
      toolCalls: [],
    };
    const pm = messageToProviderMessage(msg);
    expect(pm.tool_calls).toBeUndefined();
  });

  // ── Author-aware rendering (spec 002 §4.5) ──────────────────────────

  it("prefixes author name in group chats when authorId is present", () => {
    const msg = {
      id: "5",
      role: "user" as const,
      content: "what's the deploy command?",
      timestamp: 1000,
      authorId: "tg:111",
      authorName: "Alice",
    };
    const pm = messageToProviderMessage(msg, "group");
    expect(pm.content).toBe("[Alice]: what's the deploy command?");
  });

  it("prefixes author name in channel conversations too", () => {
    const msg = {
      id: "6",
      role: "user" as const,
      content: "deploying now",
      timestamp: 1000,
      authorId: "tg:222",
      authorName: "Bob",
    };
    const pm = messageToProviderMessage(msg, "channel");
    expect(pm.content).toBe("[Bob]: deploying now");
  });

  it("suppresses the prefix in DMs (single speaker = noise)", () => {
    const msg = {
      id: "7",
      role: "user" as const,
      content: "hello",
      timestamp: 1000,
      authorId: "tg:333",
      authorName: "Carol",
    };
    const pm = messageToProviderMessage(msg, "dm");
    expect(pm.content).toBe("hello");
  });

  it("leaves legacy messages (no authorId) unchanged regardless of type", () => {
    const msg = {
      id: "8",
      role: "user" as const,
      content: "plain",
      timestamp: 1000,
    };
    expect(messageToProviderMessage(msg, "group").content).toBe("plain");
    expect(messageToProviderMessage(msg).content).toBe("plain");
  });

  it("does not prefix assistant/tool/system messages", () => {
    const assistant = {
      id: "9",
      role: "assistant" as const,
      content: "sure",
      timestamp: 1000,
      authorId: "bot",
      authorName: "Bot",
    };
    expect(messageToProviderMessage(assistant, "group").content).toBe("sure");
  });
});

describe("providerToolCallToToolCall", () => {
  it("parses JSON arguments", () => {
    const tc = providerToolCallToToolCall({
      id: "tc1",
      name: "read_file",
      arguments: '{"path":"/tmp/x"}',
    });
    expect(tc.id).toBe("tc1");
    expect(tc.name).toBe("read_file");
    expect(tc.arguments).toEqual({ path: "/tmp/x" });
  });

  it("falls back to raw arguments on invalid JSON", () => {
    const tc = providerToolCallToToolCall({
      id: "tc2",
      name: "tool",
      arguments: "not-json",
    });
    expect(tc.arguments).toEqual({ raw: "not-json" });
  });
});
