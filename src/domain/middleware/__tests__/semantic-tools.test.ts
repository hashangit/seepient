import { describe, it, expect, vi } from 'vitest';
import { semanticToolInjectionMiddleware } from '../semantic-tools.js';
import type { PipelineContext, Middleware } from '../../../foundations/contracts/middleware.js';
import type { ToolModule } from '../../../foundations/contracts/tool.js';
import type { MCPGateway } from '../../../capabilities/gateway/gateway.js';

// ── Helpers ───────────────────────────────────────────────────────────

function createMockGateway(tools: ToolModule[]): MCPGateway {
  return { getInjectableTools: () => tools } as unknown as MCPGateway;
}

function makeContext(messages: PipelineContext['messages'], toolDefs: ToolModule['definition'][] = []): PipelineContext {
  return {
    requestId: 'test-1',
    messages,
    provider: {} as any,
    model: 'test',
    toolDefs: [...toolDefs],
    metadata: {},
    startedAt: Date.now(),
  };
}

function tool(name: string, description: string): ToolModule {
  return {
    name,
    risk: 'communications',
    definition: {
      type: 'function',
      function: { name, description, parameters: { type: 'object', properties: {}, required: [] } },
    },
    handler: vi.fn(async () => 'ok'),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('semanticToolInjectionMiddleware', () => {
  it('does nothing when no user message exists', async () => {
    const mw = semanticToolInjectionMiddleware(createMockGateway([tool('search', 'search web')]));
    const ctx = makeContext([{ id: '1', role: 'assistant', content: 'hi', timestamp: Date.now() }]);
    let nextCalled = false;
    await mw(ctx, async () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
    expect(ctx.toolDefs).toHaveLength(0);
  });

  it('does nothing when gateway has no injectable tools', async () => {
    const mw = semanticToolInjectionMiddleware(createMockGateway([]));
    const ctx = makeContext([{ id: '1', role: 'user', content: 'search the web', timestamp: Date.now() }]);
    await mw(ctx, async () => {});
    expect(ctx.toolDefs).toHaveLength(0);
  });

  it('injects relevant tools based on message content', async () => {
    const tools = [
      tool('search_web', 'Search the web for information'),
      tool('compute_math', 'Run mathematical computations'),
    ];
    const mw = semanticToolInjectionMiddleware(createMockGateway(tools));
    const ctx = makeContext([{ id: '1', role: 'user', content: 'search the web for cats', timestamp: Date.now() }]);
    await mw(ctx, async () => {});
    expect(ctx.toolDefs).toHaveLength(1);
    expect(ctx.toolDefs[0].function.name).toBe('search_web');
  });

  it('respects topK limit', async () => {
    const tools = [
      tool('search_web', 'Search the web'),
      tool('search_news', 'Search news articles'),
      tool('search_images', 'Search for images'),
      tool('compute_math', 'Run math'),
    ];
    const mw = semanticToolInjectionMiddleware(createMockGateway(tools), /* topK */ 2);
    const ctx = makeContext([{ id: '1', role: 'user', content: 'search for web and news', timestamp: Date.now() }]);
    await mw(ctx, async () => {});
    expect(ctx.toolDefs.length).toBeLessThanOrEqual(2);
  });

  it('populates ctx.metadata.injectedTools with handlers', async () => {
    const searchTool = tool('search_web', 'Search the web');
    const mw = semanticToolInjectionMiddleware(createMockGateway([searchTool]));
    const ctx = makeContext([{ id: '1', role: 'user', content: 'search the web', timestamp: Date.now() }]);
    await mw(ctx, async () => {});
    const injected = ctx.metadata.injectedTools as Map<string, ToolModule>;
    expect(injected).toBeDefined();
    expect(injected.get('search_web')).toBe(searchTool);
  });

  it('adds tool definitions to ctx.toolDefs', async () => {
    const searchTool = tool('search_web', 'Search the web');
    const mw = semanticToolInjectionMiddleware(createMockGateway([searchTool]));
    const ctx = makeContext([{ id: '1', role: 'user', content: 'search the web', timestamp: Date.now() }]);
    await mw(ctx, async () => {});
    expect(ctx.toolDefs).toHaveLength(1);
    expect(ctx.toolDefs[0]).toEqual(searchTool.definition);
  });

  it('only injects relevant tools, skipping irrelevant ones', async () => {
    const tools = [
      tool('search_web', 'Search the web for information'),
      tool('send_email', 'Send an email to a recipient'),
      tool('compute_math', 'Run mathematical computations'),
    ];
    const mw = semanticToolInjectionMiddleware(createMockGateway(tools));
    const ctx = makeContext([{ id: '1', role: 'user', content: 'I need to find information about search', timestamp: Date.now() }]);
    await mw(ctx, async () => {});
    const names = ctx.toolDefs.map(d => d.function.name);
    expect(names).toContain('search_web');
    expect(names).not.toContain('send_email');
    expect(names).not.toContain('compute_math');
  });

  it('does not inject when all tools score zero', async () => {
    const tools = [tool('compute_math', 'Run mathematical computations')];
    const mw = semanticToolInjectionMiddleware(createMockGateway(tools));
    const ctx = makeContext([{ id: '1', role: 'user', content: 'translate french to german', timestamp: Date.now() }]);
    await mw(ctx, async () => {});
    expect(ctx.toolDefs).toHaveLength(0);
    expect(ctx.metadata.injectedTools).toBeUndefined();
  });
});
