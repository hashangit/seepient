import { describe, it, expect } from "vitest";
import {
  estimateTokens,
  toSeepientError,
  messageToCanonicalMessage,
} from "../message-convert.js";
import { SeepientError, ProviderError, ToolError } from "../../../foundations/errors.js";

describe("estimateTokens", () => {
  it("uses BPE tokenization (delegates to countTokens)", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("hello world")).toBe(2);
    expect(estimateTokens("this is a longer sentence")).toBeGreaterThan(
      estimateTokens("short"),
    );
  });
});

describe("toSeepientError", () => {
  it("creates ProviderError for PROVIDER_ERROR code", () => {
    const err = toSeepientError(new Error("timeout"), "PROVIDER_ERROR");
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toBe("timeout");
  });

  it("creates ToolError for TOOL_FAILED code", () => {
    const err = toSeepientError("something bad", "TOOL_FAILED");
    expect(err).toBeInstanceOf(ToolError);
    expect(err.message).toBe("something bad");
  });

  it("creates SeepientError for unknown codes", () => {
    const err = toSeepientError("oops", "UNKNOWN");
    expect(err).toBeInstanceOf(SeepientError);
    expect(err.code).toBe("UNKNOWN");
  });

  it("sets retryable=true for PROVIDER_ERROR on default path", () => {
    const generic = toSeepientError("x", "PROVIDER_ERROR");
    expect(generic.retryable).toBe(true);
  });
});

describe("messageToCanonicalMessage", () => {
  it("converts user and assistant messages to canonical format", () => {
    const userMsg = { id: "1", role: "user" as const, content: "hello", timestamp: 1000 };
    const canonUser = messageToCanonicalMessage(userMsg);
    expect(canonUser.role).toBe("user");
    expect(canonUser.content[0]).toEqual({ type: "text", text: "hello" });

    const assistantMsg = {
      id: "2",
      role: "assistant" as const,
      content: "hi",
      toolCalls: [{ id: "call_1", name: "read_file", arguments: { path: "a.txt" } }],
      timestamp: 1000,
    };
    const canonAssistant = messageToCanonicalMessage(assistantMsg);
    expect(canonAssistant.role).toBe("assistant");
    expect(canonAssistant.content[0]).toEqual({ type: "text", text: "hi" });
    expect(canonAssistant.content[1]).toEqual({ type: "tool_use", id: "call_1", name: "read_file", input: { path: "a.txt" } });
  });
});
