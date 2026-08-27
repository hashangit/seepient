import { describe, it, expect } from 'vitest';
import { runAgentLoop } from '../../agent-loop.js';
import { createHookExecutor } from '../../hooks.js';
import { StreamingResponseAccumulator } from '../stream-accumulator.js';
import type { ToolDefinition } from '../../../foundations/contracts/tool.js';
import type { Message, StepResult } from '../../../foundations/types.js';
import { createMockRuntime } from '../../__tests__/test-doubles.js';

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
    const runtime = createMockRuntime([
      {
        text: 'Hello world',
        toolCalls: [
          {
            id: 'tc1',
            name: 'echo',
            args: { msg: 'hi' },
          },
        ],
        usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3, cost: 0 },
      },
      {
        text: 'Done',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, cost: 0 },
      },
    ]);
    const steps: StepResult[] = [];
    const result = await runAgentLoop({
      runtime,
      model: 'test',
      messages: [userMsg('hi')],
      toolDefs: [echoTool],
      maxSteps: 5,
      hooks: createHookExecutor(),
      onStep: (s) => steps.push(s),
    });

    // Text streamed as deltas
    const deltas = steps.filter((s) => s.type === 'text_delta');
    expect(deltas.map((s) => s.content ?? '').join('')).toBe('Hello worldDone');

    // Tool call reassembled and parsed.
    const toolStep = steps.find((s) => s.type === 'tool_call');
    expect(toolStep).toBeTruthy();
    expect(toolStep?.toolCall?.name).toBe('echo');
    expect(toolStep?.toolCall?.args).toEqual({ msg: 'hi' });

    // The streamed assistant text is in the message history.
    const asst = result.messages.find((m) => m.role === 'assistant' && m.content);
    expect(asst?.content).toBe('Hello world');
  });

  it('emits tool_progress steps while a streaming tool runs (T026)', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { buildLocalBoundary } = await import('../../../capabilities/execution/build-local-boundary.js');
    const { buildActionLifecycle } = await import('../../permissions/action-lifecycle-factory.js');
    const { InMemoryArtifactStore } = await import('../../../capabilities/execution/in-memory-artifact-store.js');

    const dir = mkdtempSync(join(tmpdir(), 'seepient-stream-test-'));
    const artifacts = new InMemoryArtifactStore();
    const { boundary } = await buildLocalBoundary({ artifacts, unsafeUncontained: true });
    const wiredPipeline = await buildActionLifecycle({
      principalId: 'agent-user',
      runId: 'r1',
      workspaceRoot: dir,
      approvalBroker: {
        mode: 'inline',
        request: async (req: any) => ({
          approved: true,
          requestId: req.requestId,
          actionDigest: req.actionDigest,
          optionId: req.approvalOptions[0]?.optionId ?? 'opt-1',
          lifetime: 'action',
          actorId: 'autoConfirm',
          decidedAt: Date.now(),
        }),
      },
      executionBoundary: boundary,
      artifacts,
    });

    const runtime = createMockRuntime([
      {
        toolCalls: [
          {
            id: 'tc1',
            name: 'execute_shell_command',
            args: { command: 'echo seepient-t026', rationale: 'x' },
          },
        ],
      },
      {
        text: 'Done',
      },
    ]);
    const steps: StepResult[] = [];
    await runAgentLoop({
      runtime,
      model: 't',
      messages: [userMsg('run it')],
      toolDefs: [],
      cwd: dir,
      maxSteps: 3,
      hooks: createHookExecutor(),
      autoConfirm: true,
      wiredPipeline,
      onStep: (s) => steps.push(s),
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

describe('runAgentLoop usage tracking', () => {
  it('uses real API usage from the finish delta (not char÷4 estimate)', async () => {
    const runtime = createMockRuntime([
      {
        text: 'hi',
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150, cost: 0 },
      },
    ]);
    const result = await runAgentLoop({
      runtime,
      model: 'test',
      messages: [userMsg('hello')],
      toolDefs: [],
      maxSteps: 5,
      hooks: createHookExecutor(),
    });
    // Real usage, not the char÷4 estimate of the message content
    expect(result.usage.promptTokens).toBe(100);
    expect(result.usage.completionTokens).toBe(50);
    expect(result.usage.totalTokens).toBe(150);
    // contextTokens = last request's prompt tokens
    expect(result.contextTokens).toBe(100);
  });

  it('contextTokens reflects the LAST step, not the sum across steps', async () => {
    const runtime = createMockRuntime([
      {
        toolCalls: [
          {
            id: 'tc1',
            name: 'echo',
            args: { msg: 'x' },
          },
        ],
        usage: { promptTokens: 200, completionTokens: 10, totalTokens: 210, cost: 0 },
      },
      {
        text: 'done',
        usage: { promptTokens: 300, completionTokens: 20, totalTokens: 320, cost: 0 },
      },
    ]);
    const result = await runAgentLoop({
      runtime,
      model: 'test',
      messages: [userMsg('hi')],
      toolDefs: [echoTool],
      maxSteps: 5,
      hooks: createHookExecutor(),
    });
    // Cumulative usage sums across steps
    expect(result.usage.promptTokens).toBe(500);  // 200 + 300
    expect(result.usage.completionTokens).toBe(30); // 10 + 20
    // But contextTokens = last step only
    expect(result.contextTokens).toBe(300);
  });

  it('falls back to char÷4 estimate when provider returns no usage', async () => {
    const runtime = createMockRuntime([
      { text: 'hello' },
    ]);
    const result = await runAgentLoop({
      runtime,
      model: 'test',
      messages: [userMsg('a test message')],
      toolDefs: [],
      maxSteps: 5,
      hooks: createHookExecutor(),
    });
    // Fallback: char÷4 estimate > 0
    expect(result.usage.promptTokens).toBeGreaterThan(0);
    expect(result.contextTokens).toBeGreaterThan(0);
  });
});
