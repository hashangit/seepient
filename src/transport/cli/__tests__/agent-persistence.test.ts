/**
 * Tests for CLI Agent session persistence.
 *
 * Boundary under test: the CLI Agent adapter's persistence wiring — that
 * chat() persists via the shared persistSession helper, clearConversation
 * rotates the session id, and loadSession restores history. runAgentLoop is
 * mocked so no real provider call is made.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LLMProvider } from '../../../foundations/contracts/llm.js';

function mockProvider(): LLMProvider {
  return { chat: vi.fn().mockResolvedValue({ content: 'ok' }) } as unknown as LLMProvider;
}

// Mock runAgentLoop: appends an assistant message to the messages array
// (mirroring what the real loop does) and returns a minimal valid result.
function mockRunAgentLoop() {
  const fn = vi.fn().mockImplementation(async (opts: any) => {
    opts.messages.push({
      id: 'asst-1',
      role: 'assistant',
      content: 'hello back',
      timestamp: Date.now(),
    });
    return {
      messages: opts.messages,
      steps: [],
      toolCalls: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0 },
      finishReason: 'stop',
    };
  });
  vi.doMock('../../../domain/agent-loop.js', () => ({ runAgentLoop: fn }));
  return fn;
}

// Mock runAgentLoop that rejects with an AbortError — simulates the user
// pressing ESC mid-turn. Verifies the finally-block still persists the
// partial messages (user message present, no assistant reply).
function mockRunAgentLoopAborted() {
  const fn = vi.fn().mockImplementation(async () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    throw err;
  });
  vi.doMock('../../../domain/agent-loop.js', () => ({ runAgentLoop: fn }));
  return fn;
}

beforeEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("CLI Agent persistence", () => {
  it("persists messages after chat()", async () => {
    mockRunAgentLoop();
    const { Agent } = await import('../agent.js');
    const { MemoryPersistenceBackend } = await import('../../../domain/sessions/session-store.js');

    const backend = new MemoryPersistenceBackend();
    const agent = new Agent(mockProvider(), 'gpt-test', {}, 'sys-prompt', backend, 'openai');

    await agent.chat('hi');

    const id = agent.getSessionId();
    const loaded = await backend.load(id);
    expect(loaded).not.toBeNull();
    // system + user + assistant
    expect(loaded!.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant']);
    expect(loaded!.provider).toBe('openai');
    expect(loaded!.model).toBe('gpt-test');
  });

  it("persists partial messages even when the turn is aborted", async () => {
    mockRunAgentLoopAborted();
    const { Agent } = await import('../agent.js');
    const { MemoryPersistenceBackend } = await import('../../../domain/sessions/session-store.js');

    const backend = new MemoryPersistenceBackend();
    const agent = new Agent(mockProvider(), 'gpt-test', {}, 'sys', backend);

    const result = await agent.chat('partial turn');
    expect(result.finishReason).toBe('aborted');

    // The finally-block must still have persisted — the user message survives
    // even though no assistant reply was produced.
    const loaded = await backend.load(agent.getSessionId());
    expect(loaded).not.toBeNull();
    const roles = loaded!.messages.map((m) => m.role);
    expect(roles).toContain('user');
    expect(roles).not.toContain('assistant');
  });

  it("clearConversation rotates the session id (old session untouched)", async () => {
    mockRunAgentLoop();
    const { Agent } = await import('../agent.js');
    const { MemoryPersistenceBackend } = await import('../../../domain/sessions/session-store.js');

    const backend = new MemoryPersistenceBackend();
    const agent = new Agent(mockProvider(), 'gpt-test', {}, 'sys', backend);
    await agent.chat('first turn');
    const oldId = agent.getSessionId();

    agent.clearConversation();
    const newId = agent.getSessionId();
    expect(newId).not.toBe(oldId);

    // The old session file must still exist for later resume.
    const oldSession = await backend.load(oldId);
    expect(oldSession).not.toBeNull();
    expect(oldSession!.messages.some((m) => m.role === 'user' && m.content === 'first turn')).toBe(true);
  });

  it("loadSession restores messages and sets the session id", async () => {
    mockRunAgentLoop();
    const { Agent } = await import('../agent.js');
    const { MemoryPersistenceBackend } = await import('../../../domain/sessions/session-store.js');

    const backend = new MemoryPersistenceBackend();
    const agent = new Agent(mockProvider(), 'gpt-test', {}, 'sys', backend);
    await agent.chat('turn one');
    const savedId = agent.getSessionId();

    // A fresh agent resumes by id.
    const agent2 = new Agent(mockProvider(), 'gpt-test', {}, 'sys', backend);
    const loaded = await agent2.loadSession(savedId);
    expect(loaded).toBe(true);
    expect(agent2.getSessionId()).toBe(savedId);
    expect(agent2.getMessages().map((m) => m.role)).toEqual(['system', 'user', 'assistant']);
  });

  it("loadSession returns false for an unknown id", async () => {
    const { Agent } = await import('../agent.js');
    const { MemoryPersistenceBackend } = await import('../../../domain/sessions/session-store.js');
    const agent = new Agent(mockProvider(), 'gpt-test', {}, 'sys', new MemoryPersistenceBackend());
    expect(await agent.loadSession('does-not-exist')).toBe(false);
  });

  it("re-seeds the system message when the loaded session has none", async () => {
    const { Agent } = await import('../agent.js');
    const { MemoryPersistenceBackend } = await import('../../../domain/sessions/session-store.js');
    const backend = new MemoryPersistenceBackend();
    // Manually plant a session with no system message.
    await backend.save('no-sys', {
      id: 'no-sys',
      messages: [{ id: 'u1', role: 'user', content: 'hi', timestamp: 0 }],
      createdAt: 0, updatedAt: 0,
    });
    const agent = new Agent(mockProvider(), 'gpt-test', {}, 'my sys prompt', backend);
    const loaded = await agent.loadSession('no-sys');
    expect(loaded).toBe(true);
    const roles = agent.getMessages().map((m) => m.role);
    expect(roles[0]).toBe('system');
    expect(roles).toContain('user');
  });
});
