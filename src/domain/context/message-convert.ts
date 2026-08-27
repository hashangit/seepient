/** Seepient Core — Message conversion helpers */

import type { Message } from "../../foundations/types.js";
import { SeepientError, ProviderError, ToolError } from "../../foundations/errors.js";
import { countTokens } from "../../capabilities/tokenizer/tokenizer.js";

/**
 * Get the current Unix timestamp in milliseconds.
 */
export function now(): number {
  return Date.now();
}

/**
 * Token estimate using BPE (via gpt-tokenizer). Exact for OpenAI-family
 * models, approximate elsewhere. Delegates to `countTokens`.
 */
export function estimateTokens(text: string): number {
  return countTokens(text);
}

/**
 * Create a SeepientError from a plain Error or unknown value.
 * Uses the proper class hierarchy based on the error code.
 */
export function toSeepientError(err: unknown, code: string): SeepientError {
  const message = err instanceof Error ? err.message : String(err);

  switch (code) {
    case "PROVIDER_ERROR":
      return new ProviderError(message);
    case "TOOL_FAILED":
      return new ToolError(message);
    default:
      return new SeepientError(message, code, code === "PROVIDER_ERROR");
  }
}

/**
 * Convert an internal SDK Message to canonical inference CanonicalMessage format.
 */
export function messageToCanonicalMessage(m: Message): any {
  if (m.role === "system") {
    return {
      role: "system",
      content: [{ type: "text", text: m.content || "" }],
    };
  }
  if (m.role === "user") {
    return {
      role: "user",
      content: [{ type: "text", text: m.content || "" }],
    };
  }
  if (m.role === "tool") {
    return {
      role: "tool",
      content: [
        {
          type: "tool_result",
          toolUseId: m.toolCallId ?? m.id,
          content: [{ type: "text", text: m.content || "" }],
        },
      ],
    };
  }
  if (m.role === "assistant") {
    const contentBlocks: any[] = [];
    if (m.reasoning) {
      contentBlocks.push({ type: "reasoning", text: m.reasoning });
    }
    if (m.content) {
      contentBlocks.push({ type: "text", text: m.content });
    }
    if (m.toolCalls && m.toolCalls.length > 0) {
      for (const tc of m.toolCalls) {
        contentBlocks.push({
          type: "tool_use",
          id: tc.id,
          name: tc.name,
          input: tc.arguments ?? (tc as any).args ?? {},
        });
      }
    }
    return {
      role: "assistant",
      content: contentBlocks.length > 0 ? contentBlocks : [{ type: "text", text: "" }],
    };
  }
  return {
    role: "user",
    content: [{ type: "text", text: m.content || "" }],
  };
}
