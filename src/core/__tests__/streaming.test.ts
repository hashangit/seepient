import { describe, it, expect } from 'vitest';
import { runAgentLoop } from '../agent-loop.js';
import { createHookExecutor } from '../hooks.js';
import { StreamingResponseAccumulator } from '../stream-accumulator.js';
import type { LLMProvider, StreamDelta } from '../../providers/types.js';
import type { ToolDefinition } from '../../tools/interface.js';
import type { Message, StepResult } from '../types.js';

/** Stateful mock: yields `firstCall` on the first chatStream() invocation, then
 *  `laterCalls` (default: just a finish) on every subsequent one, so the loop
 *  terminates after one tool round instead of replaying the same deltas. */
function streamProvider(firstCall: StreamDelta[], laterCalls: StreamDelta[] = [{ type: 'finish' }]): LLMProvider {
  let call = 0;
  return {
    async chat() {
      throw new Error('chat() must not be called in stream mode');
    },
    async *chatStream(): AsyncIterable<StreamDelta> {
      const deltas = call === 0 ? firstCall : laterCalls;
      call++;
      for (const d of deltas) yield d;
    },
  };
}

const echoTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'echo',
    description: 'echo back',
    parameters: { type: 'object', properties: { msg: { type: 'string' } }, required: [] },
  },
};

const userMsg = (content: string): Message => ({ id: 'u1', role: 'user', content, timestamp: 0 });

describe('runAgentLoop streaming', () => {
  it('emits text_delta steps and reconstructs fragmented tool-call arguments', async () => {
    const provider = streamProvider([
      { type: 'text_delta', content: 'Hello' },
      { type: 'text_delta', content: ' world' },
      { type: 'tool_call_begin', index: 0, id: 'tc1', name: 'echo' },
      { type: 'tool_call_delta', index: 0, argumentsDelta: '{"msg":"h' },
      { type: 'tool_call_delta', index: 0, argumentsDelta: 'i"}' },
      { type: 'finish', usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3, cost: 0 } },
    ]);
    const steps: StepResult[] = [];
    const result = await runAgentLoop({
      provider,
      model: 'test',
      messages: [userMsg('hi')],
      toolDefs: [echoTool],
      maxSteps: 5,
      hooks: createHookExecutor(),
      onStep: (s) => steps.push(s),
      stream: true,
    });

    // Text streamed as deltas; no complete 'text' step in stream mode.
    const deltas = steps.filter((s) => s.type === 'text_delta');
    expect(deltas.map((s) => s.content ?? '').join('')).toBe('Hello world');
    expect(steps.some((s) => s.type === 'text')).toBe(false);

    // Tool call reassembled from fragments and parsed.
    const toolStep = steps.find((s) => s.type === 'tool_call');
    expect(toolStep).toBeTruthy();
    expect(toolStep?.toolCall?.name).toBe('echo');
    expect(toolStep?.toolCall?.args).toEqual({ msg: 'hi' });

    // The streamed assistant text is in the message history.
    const asst = result.messages.find((m) => m.role === 'assistant' && m.content);
    expect(asst?.content).toBe('Hello world');
  });

  it('falls back to chat() (no text_delta) when stream is false', async () => {
    let chatCalled = false;
    const provider: LLMProvider = {
      async chat() {
        chatCalled = true;
        return { content: 'complete' };
      },
    };
    const steps: StepResult[] = [];
    await runAgentLoop({
      provider,
      model: 't',
      messages: [userMsg('hi')],
      toolDefs: [],
      maxSteps: 5,
      hooks: createHookExecutor(),
      onStep: (s) => steps.push(s),
      stream: false,
    });
    expect(chatCalled).toBe(true);
    expect(steps.filter((s) => s.type === 'text_delta')).toHaveLength(0);
    expect(steps.filter((s) => s.type === 'text').map((s) => s.content)).toEqual(['complete']);
  });

  it('emits tool_progress steps while a streaming tool runs (T026)', async () => {
    // Provider requests a real execute_shell_command; autoConfirm bypasses the
    // permission gate so it actually runs and streams stdout.
    const provider = streamProvider([
      { type: 'tool_call_begin', index: 0, id: 'tc1', name: 'execute_shell_command' },
      { type: 'tool_call_delta', index: 0, argumentsDelta: '{"command":"echo seepient-t026","rationale":"x"}' },
      { type: 'finish' },
    ]);
    const steps: StepResult[] = [];
    await runAgentLoop({
      provider,
      model: 't',
      messages: [userMsg('run it')],
      toolDefs: [],
      maxSteps: 3,
      hooks: createHookExecutor(),
      onStep: (s) => steps.push(s),
      stream: true,
      autoConfirm: true,
    });
    const progress = steps.filter((s) => s.type === 'tool_progress');
    const toolCall = steps.find((s) => s.type === 'tool_call');
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.some((s) => (s.content ?? '').includes('seepient-t026'))).toBe(true);
    expect(toolCall?.toolCall?.result).toContain('seepient-t026');
  });
});

describe('StreamingResponseAccumulator', () => {
  it('reassembles fragmented tool-call arguments by index', () => {
    const acc = new StreamingResponseAccumulator();
    acc.beginToolCall(0, 'id1', 'echo');
    acc.appendToolCallArgs(0, '{"msg":"h');
    acc.appendToolCallArgs(0, 'i"}');
    acc.appendText('Hi');
    const r = acc.toResponse();
    expect(r.content).toBe('Hi');
    expect(r.tool_calls).toEqual([{ id: 'id1', name: 'echo', arguments: '{"msg":"hi"}' }]);
  });

  it('orders multiple tool calls by index', () => {
    const acc = new StreamingResponseAccumulator();
    acc.beginToolCall(1, 'b', 'second');
    acc.beginToolCall(0, 'a', 'first');
    const r = acc.toResponse();
    expect(r.tool_calls?.map((tc) => tc.id)).toEqual(['a', 'b']);
  });
});
