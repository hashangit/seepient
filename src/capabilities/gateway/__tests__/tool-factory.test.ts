import { describe, it, expect } from 'vitest';
import { createGatewayTools } from '../tool-factory.js';
import { MCPGateway } from '../gateway.js';
import { GatewaySettingsAdapter } from '../settings-adapter.js';

function createMockGateway(): MCPGateway {
  const adapter = new GatewaySettingsAdapter('/tmp/seepient-test-' + process.pid);
  return new MCPGateway(adapter, {
    enabled: true,
    semanticTopK: 3,
    defaultRateLimitPerMin: 60,
    maxAuditLogsInMemory: 100,
  });
}

describe('createGatewayTools', () => {
  it('returns 10 tools', () => {
    const tools = createGatewayTools(createMockGateway());
    expect(tools).toHaveLength(10);
  });

  it('all tools have explicit risk categories', () => {
    const tools = createGatewayTools(createMockGateway());
    for (const tool of tools) {
      expect(tool.risk).toBeDefined();
      expect(['safe', 'communications']).toContain(tool.risk);
    }
  });

  it('all tools have valid definitions', () => {
    const tools = createGatewayTools(createMockGateway());
    for (const tool of tools) {
      expect(tool.definition.type).toBe('function');
      expect(tool.definition.function.name).toBeTruthy();
      expect(tool.definition.function.description).toBeTruthy();
      expect(tool.definition.function.name).toMatch(/^gateway_/);
    }
  });

  it('includes all expected tool names', () => {
    const tools = createGatewayTools(createMockGateway());
    const names = tools.map(t => t.definition.function.name);
    expect(names).toContain('gateway_route');
    expect(names).toContain('gateway_call_tool');
    expect(names).toContain('gateway_call_rest');
    expect(names).toContain('gateway_capabilities');
    expect(names).toContain('gateway_audit_log');
    expect(names).toContain('gateway_usage_stats');
  });
});
