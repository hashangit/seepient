import { describe, it, expect, vi, beforeEach } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

function mockEntryPoints(resolvedModel: string) {
  const runAgentLoopMock = vi.fn().mockImplementation(async (opts: any) => ({
    messages: [{ id: '1', role: 'assistant', content: 'ok', timestamp: 0 }],
    steps: [],
    toolCalls: [],
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0 },
    finishReason: 'stop',
  }));

  const mockRuntime = {
    createTurnSnapshot: vi.fn().mockResolvedValue({
      catalog: [],
      timestamp: Date.now(),
    }),
    resolvePlan: vi.fn().mockImplementation(async (_snap, _purpose, _tier, override) => ({
      selectedTarget: {
        providerAccount: 'test-account',
        model: override?.model ?? resolvedModel,
      },
    })),
    executeLanguage: vi.fn().mockImplementation(async function* () {
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } };
      yield { type: 'finish', stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } };
    }),
  };

  vi.doMock('../../../domain/providers/provider-runtime.js', () => ({
    getDefaultProviderRuntime: vi.fn().mockReturnValue(mockRuntime),
    ProviderRuntime: vi.fn().mockImplementation(() => mockRuntime),
  }));

  vi.doMock('../../../domain/agent-loop.js', () => ({
    runAgentLoop: runAgentLoopMock,
  }));

  return { runAgentLoopMock, mockRuntime };
}

describe('SDK opts.model override', () => {
  it('generateText uses opts.model over the resolved default', async () => {
    const { runAgentLoopMock } = mockEntryPoints('resolved-default-model');
    const { generateText } = await import('../index.js');

    await generateText('hi', { tools: [], model: 'override-model' });

    expect(runAgentLoopMock).toHaveBeenCalledTimes(1);
    const passedModel = runAgentLoopMock.mock.calls[0][0].modelOverride;
    expect(passedModel).toBe('override-model');
  });

  it('generateText passes undefined when opts.model omitted', async () => {
    const { runAgentLoopMock } = mockEntryPoints('resolved-default-model');
    const { generateText } = await import('../index.js');

    await generateText('hi', { tools: [] });

    expect(runAgentLoopMock.mock.calls[0][0].modelOverride).toBeUndefined();
  });

  it('streamText uses opts.model over the resolved default', async () => {
    const { runAgentLoopMock } = mockEntryPoints('resolved-default-model');
    const { streamText } = await import('../index.js');

    const res = await streamText('hi', { tools: [], model: 'override-stream' });
    await res.fullText;

    expect(runAgentLoopMock.mock.calls[0][0].modelOverride).toBe('override-stream');
  });

  it('createAgent uses opts.model over the resolved default', async () => {
    const { runAgentLoopMock } = mockEntryPoints('resolved-default-model');
    const { createAgent } = await import('../agent.js');

    const agent = await createAgent({ tools: [], model: 'override-agent' });
    await agent.chat('hi');

    expect(runAgentLoopMock.mock.calls[0][0].modelOverride).toEqual({ model: 'override-agent', providerAccount: undefined });
  });

  it('createAgent switchProvider routes subsequent chats through the account + model', async () => {
    const { runAgentLoopMock } = mockEntryPoints('resolved-default-model');
    const { createAgent } = await import('../agent.js');

    const agent = await createAgent({ tools: [] });
    await agent.switchProvider('main', 'switched-model');
    await agent.chat('hi');

    expect(runAgentLoopMock.mock.calls[0][0].modelOverride).toEqual({ model: 'switched-model', providerAccount: 'main' });
  });
});
