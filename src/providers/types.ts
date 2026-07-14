export type { ProviderType } from "../core/types.js";

import type { ToolDefinition } from '../tools/interface.js';
import type { Usage } from '../core/types.js';

export interface ProviderMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string;
  tool_calls?: ProviderToolCall[];
  tool_call_id?: string;
}

export interface ProviderToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ProviderResponse {
  content?: string;
  tool_calls?: ProviderToolCall[];
  /** Real token usage from the provider API, when available. */
  usage?: Usage;
}

export interface ChatOptions {
  signal?: AbortSignal;
}

/**
 * A single chunk from a streaming model response. Providers split a response
 * across many deltas — text arrives token-by-token, and a tool call's JSON
 * arguments usually arrive fragmented. `runAgentLoop` reassembles these via
 * `StreamingResponseAccumulator`.
 */
export type StreamDelta =
  | { type: 'text_delta'; content: string }
  | { type: 'tool_call_begin'; index: number; id: string; name: string }
  | { type: 'tool_call_delta'; index: number; argumentsDelta: string }
  | { type: 'finish'; usage?: Usage };

export interface LLMProvider {
  chat(messages: ProviderMessage[], tools: ToolDefinition[], options?: ChatOptions): Promise<ProviderResponse>;
  /** Optional streaming variant. Absent → callers fall back to `chat()`. */
  chatStream?(messages: ProviderMessage[], tools: ToolDefinition[], options?: ChatOptions): AsyncIterable<StreamDelta>;
}
