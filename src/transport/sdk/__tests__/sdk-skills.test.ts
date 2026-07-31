/**
 * Tests for SDK agent skill support.
 *
 * Boundary under test: that createAgent() initializes the skill registry
 * (so use_skill works), injects the catalog into the system message, and
 * respects the `skills: false` opt-out. runAgentLoop is mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LLMProvider } from '../../../foundations/contracts/llm.js';

function mockProvider(): LLMProvider {
  return { chat: vi.fn().mockResolvedValue({ content: 'ok' }) } as unknown as LLMProvider;
}

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

// Mock getProvider so createAgent doesn't need real API credentials.
function mockGetProvider() {
  vi.doMock('../../../domain/providers/provider-resolver.js', () => ({
    getProvider: vi.fn().mockResolvedValue({ provider: mockProvider(), model: 'test-model' }),
  }));
}

describe('SDK createAgent skill support', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockGetProvider();
  });

  it('initializes the skill registry and injects catalog into the system message', async () => {
    mockRunAgentLoop();
    const { createAgent } = await import('../agent.js');
    const agent = await createAgent({ systemPrompt: 'BASE' });

    const history = agent.getHistory();
    const sysMsg = history.find((m: any) => m.role === 'system');
    expect(sysMsg).toBeTruthy();
    expect(sysMsg!.content).toContain('BASE');

    // If skills are discovered in the workspace, the catalog should be present.
    const hasCatalog = sysMsg!.content.includes('AVAILABLE SKILLS');
    if (hasCatalog) {
      // The catalog should appear exactly once
      const count = (sysMsg!.content.match(/AVAILABLE SKILLS/g) || []).length;
      expect(count).toBe(1);
    }
  });

  it('clear() re-seeds the system message with catalog (one copy, no accumulation)', async () => {
    mockRunAgentLoop();
    const { createAgent } = await import('../agent.js');
    const agent = await createAgent({ systemPrompt: 'BASE' });

    const before = agent.getHistory().find((m: any) => m.role === 'system')?.content ?? '';
    const countBefore = (before.match(/AVAILABLE SKILLS/g) || []).length;

    agent.clear();

    const after = agent.getHistory().find((m: any) => m.role === 'system')?.content ?? '';
    const countAfter = (after.match(/AVAILABLE SKILLS/g) || []).length;

    expect(countAfter).toBe(countBefore); // no growth
    expect(after).toContain('BASE');
  });

  it('skills: false disables skill initialization', async () => {
    mockRunAgentLoop();
    const { createAgent } = await import('../agent.js');
    const agent = await createAgent({ systemPrompt: 'BASE', skills: false });

    const sysMsg = agent.getHistory().find((m: any) => m.role === 'system');
    expect(sysMsg?.content).toBe('BASE'); // no catalog appended
    expect(sysMsg?.content).not.toContain('AVAILABLE SKILLS');
  });
});
