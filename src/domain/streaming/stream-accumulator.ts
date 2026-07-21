/**
 * StreamingResponseAccumulator — reassembles a complete `ProviderResponse`
 * ({ content, tool_calls }) from a stream of `StreamDelta`s.
 *
 * Provider streams frequently split a tool call's JSON `arguments` across many
 * deltas; this buffers each tool call by index and concatenates the fragments,
 * so `runAgentLoop` receives well-formed, complete tool calls to execute.
 */

import type { ProviderResponse, ProviderToolCall } from '../../foundations/contracts/llm.js';
import type { Usage } from '../../foundations/types.js';

interface ToolCallAcc {
  index: number;
  id: string;
  name: string;
  argumentsBuffer: string;
}

export class StreamingResponseAccumulator {
  private text = '';
  private toolCalls = new Map<number, ToolCallAcc>();
  private usage: Usage | undefined;

  appendText(delta: string): void {
    this.text += delta;
  }

  beginToolCall(index: number, id: string, name: string): void {
    const existing = this.toolCalls.get(index);
    if (existing) {
      existing.id = id || existing.id;
      existing.name = name || existing.name;
    } else {
      this.toolCalls.set(index, { index, id, name, argumentsBuffer: '' });
    }
  }

  appendToolCallArgs(index: number, argsDelta: string): void {
    const tc = this.toolCalls.get(index);
    if (tc) {
      tc.argumentsBuffer += argsDelta;
    } else {
      // delta arrived before begin — create a placeholder at this index
      this.toolCalls.set(index, { index, id: '', name: '', argumentsBuffer: argsDelta });
    }
  }

  setUsage(usage: Usage): void {
    this.usage = usage;
  }

  getUsage(): Usage | undefined {
    return this.usage;
  }

  toResponse(): ProviderResponse {
    const tool_calls: ProviderToolCall[] = [...this.toolCalls.values()]
      .sort((a, b) => a.index - b.index)
      .map((tc) => ({ id: tc.id, name: tc.name, arguments: tc.argumentsBuffer }));
    return {
      content: this.text || undefined,
      tool_calls: tool_calls.length > 0 ? tool_calls : undefined,
    };
  }
}
