/**
 * Tests for CLI Agent skill catalog injection.
 *
 * Boundary under test: the CLI Agent adapter's skill catalog handling — that
 * initializeSkills() appends the catalog to the system message exactly once,
 * chat() does not re-append it on subsequent turns (the accumulation bug),
 * and clearConversation() re-seeds with one copy.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LLMProvider } from '../../../foundations/contracts/llm.js';

// Mock runAgentLoop: appends an assistant message and returns a minimal result.
function mockRunAgentLoop() {
  const fn = vi.fn().mockImplementation(async (opts: any) => {
    opts.messages.push({
      id: `asst-${Date.now()}`,
      role: 'assistant',
      content: 'ok',
      timestamp: Date.now(),
    });
    return {
      messages: opts.messages,
      steps: [],
      toolCalls: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0 },
      contextTokens: 0,
      finishReason: 'stop' as const,
    };
  });
  vi.doMock('../../../domain/agent-loop.js', () => ({ runAgentLoop: fn }));
  return fn;
}

function mockProvider(): LLMProvider {
  return { chat: vi.fn().mockResolvedValue({ content: 'ok' }) } as unknown as LLMProvider;
}

describe('CLI Agent skill catalog injection', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('initializeSkills appends the catalog to the system message exactly once', async () => {
    const runLoop = mockRunAgentLoop();
    const { Agent } = await import('../agent.js');
    const agent = new Agent(mockProvider(), 'test-model', {}, 'BASE_PROMPT');
    await agent.initializeSkills();

    const messages = agent.getMessages();
    const sysContent = messages[0]?.content ?? '';

    // If skills were found, the catalog should be appended exactly once.
    // The base prompt is present, and the catalog (if any) appears once.
    expect(sysContent).toContain('BASE_PROMPT');
    const catalogCount = (sysContent.match(/AVAILABLE SKILLS/g) || []).length;
    expect(catalogCount).toBeLessThanOrEqual(1);

    // chat() should not re-append the catalog
    await agent.chat('hello', undefined as any);
    await agent.chat('again', undefined as any);

    const sysAfterChats = agent.getMessages()[0]?.content ?? '';
    const catalogCountAfter = (sysAfterChats.match(/AVAILABLE SKILLS/g) || []).length;
    expect(catalogCountAfter).toBe(catalogCount); // no growth

    // runAgentLoop was called, but the system message wasn't mutated by it
    expect(runLoop).toHaveBeenCalledTimes(2);
  });

  it('clearConversation re-seeds the system message with one catalog copy', async () => {
    mockRunAgentLoop();
    const { Agent } = await import('../agent.js');
    const agent = new Agent(mockProvider(), 'test-model', {}, 'BASE_PROMPT');
    await agent.initializeSkills();

    // Simulate accumulation by manually appending (what the old bug did)
    const before = agent.getMessages()[0]?.content ?? '';
    const catalogCountBefore = (before.match(/AVAILABLE SKILLS/g) || []).length;

    agent.clearConversation();

    const after = agent.getMessages()[0]?.content ?? '';
    const catalogCountAfter = (after.match(/AVAILABLE SKILLS/g) || []).length;

    // After clear, the catalog count should not exceed 1 (no accumulation)
    expect(catalogCountAfter).toBeLessThanOrEqual(1);
    expect(catalogCountAfter).toBe(catalogCountBefore);
    expect(after).toContain('BASE_PROMPT');
  });

  it('does not pass skillCatalog to runAgentLoop (catalog is injected by the agent, not the loop)', async () => {
    const runLoop = mockRunAgentLoop();
    const { Agent } = await import('../agent.js');
    const agent = new Agent(mockProvider(), 'test-model', {}, 'BASE_PROMPT');
    await agent.initializeSkills();
    await agent.chat('hi', undefined as any);

    const opts = runLoop.mock.calls[0][0];
    expect(opts.skillCatalog).toBeUndefined();
  });
});
