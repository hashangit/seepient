/**
 * Unit tests for SDK option handling — specifically that `opts.model` overrides
 * the provider-resolved default model (previously a dead field).
 *
 * These tests mock getProvider (to control the resolved model) and runAgentLoop
 * (to capture exactly what the SDK entry passes through). The boundary under
 * test is the SDK adapter, not the agent loop internals.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LLMProvider } from '../../../foundations/contracts/llm.js';

function mockProvider(): LLMProvider {
  return { chat: vi.fn().mockResolvedValue({ content: 'ok' }) } as unknown as LLMProvider;
}

beforeEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

// Shared mock setup: getProvider returns a known resolved model, runAgentLoop
// captures its options and returns a minimal valid result.
function mockEntryPoints(resolvedModel: string) {
  const runAgentLoopMock = vi.fn().mockResolvedValue({
    messages: [{ id: '1', role: 'assistant', content: 'ok', timestamp: 0 }],
    steps: [],
    toolCalls: [],
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0 },
    finishReason: 'stop',
  });

  vi.doMock('../../../domain/providers/provider-resolver.js', () => ({
    getProvider: vi.fn().mockImplementation((_type?: any, modelOverride?: string) => ({
      provider: mockProvider(),
      model: modelOverride ?? resolvedModel,
    })),
    configureProviders: vi.fn(),
    provider: vi.fn(),
    getProviderConfig: vi.fn(),
    getDefaultProvider: vi.fn(),
    getDefaultProviderType: vi.fn(),
    saveConfig: vi.fn(),
  }));

  vi.doMock('../../../domain/agent-loop.js', () => ({
    runAgentLoop: runAgentLoopMock,
  }));

  return { runAgentLoopMock };
}

describe('SDK opts.model override', () => {
  it('generateText uses opts.model over the resolved default', async () => {
    const { runAgentLoopMock } = mockEntryPoints('resolved-default-model');
    const { generateText } = await import('../index.js');

    await generateText('hi', { tools: [], model: 'override-model' });

    expect(runAgentLoopMock).toHaveBeenCalledTimes(1);
    const passedModel = runAgentLoopMock.mock.calls[0][0].model;
    expect(passedModel).toBe('override-model');
  });

  it('generateText falls back to resolved model when opts.model omitted', async () => {
    const { runAgentLoopMock } = mockEntryPoints('resolved-default-model');
    const { generateText } = await import('../index.js');

    await generateText('hi', { tools: [] });

    expect(runAgentLoopMock.mock.calls[0][0].model).toBe('resolved-default-model');
  });

  it('streamText uses opts.model over the resolved default', async () => {
    const { runAgentLoopMock } = mockEntryPoints('resolved-default-model');
    const { streamText } = await import('../index.js');

    await streamText('hi', { tools: [], model: 'override-stream' });

    expect(runAgentLoopMock.mock.calls[0][0].model).toBe('override-stream');
  });

  it('createAgent uses opts.model over the resolved default', async () => {
    const { runAgentLoopMock } = mockEntryPoints('resolved-default-model');
    const { createAgent } = await import('../agent.js');

    const agent = await createAgent({ tools: [], model: 'override-agent' });
    await agent.chat('hi');

    expect(runAgentLoopMock.mock.calls[0][0].model).toBe('override-agent');
  });
});
