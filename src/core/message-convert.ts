/** Seepient Core — Message conversion helpers */

import type { Message, ToolCall } from "./types.js";
import { SeepientError, ProviderError, ToolError } from "./errors.js";
import type { ProviderMessage, ProviderResponse, ProviderToolCall } from "../providers/types.js";

/**
 * Generate a unique identifier using crypto.randomUUID().
 */
export function generateId(): string {
  return crypto.randomUUID();
}

/**
 * Get the current Unix timestamp in milliseconds.
 */
export function now(): number {
  return Date.now();
}

/**
 * Rough token estimate: ~4 characters per token.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
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
 * Convert an SDK Message to ProviderMessage format.
 */
export function messageToProviderMessage(msg: Message): ProviderMessage {
  const pm: ProviderMessage = { role: msg.role, content: msg.content };
  if (msg.toolCalls && msg.toolCalls.length > 0) {
    pm.tool_calls = msg.toolCalls.map((tc) => ({
      id: tc.id,
      name: tc.name,
      arguments: JSON.stringify(tc.arguments),
    }));
  }
  if (msg.toolCallId) {
    pm.tool_call_id = msg.toolCallId;
  }
  return pm;
}

/**
 * Convert a ProviderToolCall to SDK ToolCall format.
 */
export function providerToolCallToToolCall(tc: ProviderToolCall): ToolCall {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(tc.arguments);
  } catch {
    args = { raw: tc.arguments };
  }
  return {
    id: tc.id,
    name: tc.name,
    arguments: args,
  };
}

/**
 * Convert a ProviderResponse into an array of SDK Message objects.
 *
 * A single provider response may contain both text content and tool calls.
 * This function normalises it into one or more Message objects:
 *  - An assistant message with text content (and optional toolCalls)
 *  - If only tool calls with no text, an assistant message with empty content
 *
 * @param response - The raw ProviderResponse from the LLM provider.
 * @returns Array of Message objects representing the response.
 */
export function providerResponseToMessages(response: ProviderResponse): Message[] {
  const messages: Message[] = [];

  // Build assistant message
  const toolCalls = response.tool_calls?.map(providerToolCallToToolCall) ?? [];
  const assistantMsg: Message = {
    id: generateId(),
    role: "assistant",
    content: response.content ?? "",
    timestamp: now(),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };
  messages.push(assistantMsg);

  return messages;
}
