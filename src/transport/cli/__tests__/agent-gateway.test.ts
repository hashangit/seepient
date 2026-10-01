/**
 * CLI Agent Gateway Integration Test (Spec 022 T011, M9 parity).
 *
 * Verifies that a settings-configured gateway yields MCP tool definitions
 * in the agent's toolDefs and executes one via the agent's own registry.
 */
import { describe, it, expect, vi } from 'vitest';
import { Agent } from '../agent.js';
import { createGateway } from '../../../capabilities/gateway/index.js';
import type { GatewaySettingsAdapter } from '../../../capabilities/gateway/settings-adapter.js';
import { createMockRuntime } from '../../../domain/__tests__/test-doubles.js';

function createMockSettings(overrides?: Partial<GatewaySettingsAdapter>): GatewaySettingsAdapter {
  return {
    getTargets: () => ({}),
    getRoutes: () => [],
    getAdminTargets: () => new Set<string>(),
    saveTarget: vi.fn(),
    deleteTarget: vi.fn(),
    saveRoutes: vi.fn(),
    getCredential: () => undefined,
    setCredential: vi.fn(),
    deleteCredential: vi.fn(),
    listCredentialKeys: () => [],
    addAdminTarget: vi.fn(),
    removeAdminTarget: vi.fn(),
    ...overrides,
  } as unknown as GatewaySettingsAdapter;
}

describe('CLI Agent Gateway Integration (T011)', () => {
  it('yields MCP tool definitions in agent and executes one', async () => {
    const runtime = createMockRuntime([{ content: 'ok' }]);
    const agent = new Agent(runtime, 'test-model');

    const adapter = createMockSettings();
    const gwResult = await createGateway({ enabled: true } as any, adapter);
    expect(gwResult).not.toBeNull();

    // Register gateway tools into agent's own registry
    agent.registerManyTools(gwResult!.tools);

    // Assert gateway tool definitions appear in agent.getToolDefinitions()
    const defs = agent.getToolDefinitions();
    const routeDef = defs.find((d) => d.function.name === 'gateway_route');
    expect(routeDef).toBeDefined();
    expect(routeDef?.function.name).toBe('gateway_route');

    // Find the tool in the agent's registry and execute it
    const routeTool = agent.getToolRegistry().find('gateway_route');
    expect(routeTool).toBeDefined();
    expect(routeTool?.handler).toBeDefined();

    const result = await routeTool!.handler!({ request: 'send a message' });
    expect(result).toBeDefined();
    expect(typeof result).toBe('string');
  });
});
