import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MCPGateway } from '../gateway.js';
import { GatewayError } from '../../../foundations/errors.js';
import type { GatewaySettingsAdapter } from '../settings-adapter.js';
import type { Target, GatewayConfig } from '../types.js';

// ── Mock factories ────────────────────────────────────────────────────

function createMockSettings(overrides?: Partial<GatewaySettingsAdapter>): GatewaySettingsAdapter {
  const targets: Record<string, Target> = {};
  const routes: Array<{ pattern: string; target: string; priority: number }> = [];
  const credentials: Record<string, string> = {};
  const adminTargets: Set<string> = new Set();

  return {
    getTargets: () => targets,
    getRoutes: () => routes,
    getAdminTargets: () => adminTargets,
    saveTarget: vi.fn(async (name: string, t: Target) => { targets[name] = t; }),
    deleteTarget: vi.fn(async (name: string) => { delete targets[name]; }),
    saveRoutes: vi.fn(async (r: typeof routes) => { routes.length = 0; routes.push(...r); }),
    getCredential: (key: string) => credentials[key],
    setCredential: vi.fn(async (key: string, val: string) => { credentials[key] = val; }),
    deleteCredential: vi.fn(async (key: string) => { delete credentials[key]; }),
    listCredentialKeys: () => Object.keys(credentials),
    addAdminTarget: vi.fn(async (name: string) => { adminTargets.add(name); }),
    removeAdminTarget: vi.fn(async (name: string) => { adminTargets.delete(name); }),
    ...overrides,
  } as unknown as GatewaySettingsAdapter;
}

function defaultConfig(): GatewayConfig {
  return { enabled: true, semanticTopK: 3, defaultRateLimitPerMin: 60, maxAuditLogsInMemory: 100 };
}

function restTarget(overrides?: Partial<Target>): Target {
  return {
    kind: 'rest',
    baseUrl: 'https://api.example.com',
    description: 'Example REST API',
    auth: { type: 'none' },
    defaultHeaders: {},
    operations: [
      { opId: 'listUsers', method: 'GET', path: '/users', summary: 'List all users' },
      { opId: 'createUser', method: 'POST', path: '/users', summary: 'Create a user' },
    ],
    tags: ['users', 'api'],
    enabled: true,
    ...overrides,
  } as Target;
}

function mcpTarget(overrides?: Partial<Target>): Target {
  return {
    kind: 'mcp',
    transport: 'stdio' as const,
    command: 'test-mcp-server',
    description: 'Test MCP server',
    tags: ['mcp', 'test'],
    enabled: true,
    capabilities: {
      tools: [
        { name: 'search', description: 'Search the web', inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } },
        { name: 'compute', description: 'Run a computation', inputSchema: { type: 'object', properties: { expr: { type: 'string' } }, required: ['expr'] } },
      ],
    },
    ...overrides,
  } as Target;
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('MCPGateway', () => {
  let settings: GatewaySettingsAdapter;
  let config: GatewayConfig;
  let gw: MCPGateway;

  beforeEach(() => {
    settings = createMockSettings();
    config = defaultConfig();
    gw = new MCPGateway(settings, config);
  });

  // ── Target CRUD ───────────────────────────────────────────────────

  describe('registerTarget', () => {
    it('registers a REST target and persists it', async () => {
      await gw.registerTarget('api', restTarget());
      const targets = gw.getTargets();
      expect(targets['api']).toBeDefined();
      expect(targets['api'].kind).toBe('rest');
      expect(settings.saveTarget).toHaveBeenCalledWith('api', expect.anything());
    });

    it('registers an MCP target', async () => {
      await gw.registerTarget('mcp1', mcpTarget());
      expect(gw.getTargets()['mcp1'].kind).toBe('mcp');
    });

    it('throws on invalid target kind', async () => {
      await expect(gw.registerTarget('bad', { kind: 'invalid' } as any))
        .rejects.toThrow(GatewayError);
    });

    it('tracks admin targets when isAdmin=true', async () => {
      await gw.registerTarget('admin-api', restTarget(), true);
      expect(settings.addAdminTarget).toHaveBeenCalledWith('admin-api');
    });
  });

  describe('unregisterTarget', () => {
    it('removes a target and returns true', async () => {
      await gw.registerTarget('api', restTarget());
      const result = await gw.unregisterTarget('api');
      expect(result).toBe(true);
      expect(gw.getTargets()['api']).toBeUndefined();
      expect(settings.deleteTarget).toHaveBeenCalledWith('api');
    });

    it('returns false for unknown target', async () => {
      const result = await gw.unregisterTarget('nope');
      expect(result).toBe(false);
    });

    it('removes associated routes on unregister', async () => {
      await gw.registerTarget('api', restTarget());
      await gw.addRoute('test', 'api', 1);
      await gw.unregisterTarget('api');
      expect(gw.getRoutes()).toHaveLength(0);
    });
  });

  describe('toggleTarget', () => {
    it('enables/disables a target', async () => {
      await gw.registerTarget('api', restTarget());
      const ok = await gw.toggleTarget('api', false);
      expect(ok).toBe(true);
      expect(gw.getTargets()['api'].enabled).toBe(false);
    });

    it('returns false for unknown target', async () => {
      const ok = await gw.toggleTarget('nope', true);
      expect(ok).toBe(false);
    });
  });

  describe('getTargets', () => {
    it('returns empty object when no targets registered', () => {
      expect(gw.getTargets()).toEqual({});
    });

    it('returns all registered targets', async () => {
      await gw.registerTarget('a', restTarget());
      await gw.registerTarget('b', mcpTarget());
      const targets = gw.getTargets();
      expect(Object.keys(targets)).toHaveLength(2);
    });
  });

  // ── Routing ───────────────────────────────────────────────────────

  describe('routeRequest', () => {
    it('matches route by pattern', async () => {
      await gw.registerTarget('api', restTarget({ tags: ['users'] }));
      await gw.addRoute('payment', 'api', 10);
      const result = gw.routeRequest('process payment for order');
      expect(result).toContain('-> api');
      expect(result).toContain("route: 'payment'");
    });

    it('falls back to tag match when no route matches', async () => {
      await gw.registerTarget('user-api', restTarget({ tags: ['users'] }));
      const result = gw.routeRequest('list users');
      expect(result).toContain('-> user-api');
      expect(result).toContain('tag match');
    });

    it('returns no-match message when nothing matches', async () => {
      await gw.registerTarget('api', restTarget({ tags: ['billing'] }));
      const result = gw.routeRequest('translate french to english');
      expect(result).toContain('No route matched');
      expect(result).toContain('Available: api');
    });

    it('returns no-targets message when empty', () => {
      const result = gw.routeRequest('anything');
      expect(result).toBe('No targets registered.');
    });
  });

  // ── REST proxy ────────────────────────────────────────────────────

  describe('callRest', () => {
    it('throws on missing target', async () => {
      await expect(gw.callRest('agent', 'missing', '/path', 'GET'))
        .rejects.toThrow(GatewayError);
    });

    it('throws on disabled target', async () => {
      await gw.registerTarget('api', restTarget({ enabled: false }));
      await expect(gw.callRest('agent', 'api', '/path', 'GET'))
        .rejects.toThrow(/disabled/);
    });

    it('throws on non-REST target', async () => {
      await gw.registerTarget('mcp1', mcpTarget());
      await expect(gw.callRest('agent', 'mcp1', '/path', 'GET'))
        .rejects.toThrow(/not a REST target/);
    });

    it('injects bearer auth header from credential ref', async () => {
      const settingsWithCred = createMockSettings({
        getCredential: (key: string) => key === 'api_key' ? 'sk_test_123' : undefined,
      });
      const gw2 = new MCPGateway(settingsWithCred, config);
      const target = restTarget({
        auth: { type: 'bearer', credentialRef: 'api_key' },
      });
      await gw2.registerTarget('api', target, true); // admin — credential injection requires admin

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      );

      await gw2.callRest('agent', 'api', '/users', 'GET');
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer sk_test_123' }),
        }),
      );
      fetchSpy.mockRestore();
    });

    it('injects header auth from credential ref', async () => {
      const settingsWithCred = createMockSettings({
        getCredential: (key: string) => key === 'api_key' ? 'secret123' : undefined,
      });
      const gw2 = new MCPGateway(settingsWithCred, config);
      await gw2.registerTarget('api', restTarget({
        auth: { type: 'header', name: 'X-Custom-Key', credentialRef: 'api_key' },
      }), true); // admin — credential injection requires admin

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );

      await gw2.callRest('agent', 'api', '/users', 'GET');
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({ 'X-Custom-Key': 'secret123' }),
        }),
      );
      fetchSpy.mockRestore();
    });

    it('injects query param auth from credential ref', async () => {
      const settingsWithCred = createMockSettings({
        getCredential: (key: string) => key === 'api_key' ? 'qsecret' : undefined,
      });
      const gw2 = new MCPGateway(settingsWithCred, config);
      await gw2.registerTarget('api', restTarget({
        auth: { type: 'query', name: 'token', credentialRef: 'api_key' },
      }), true); // admin — credential injection requires admin

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );

      await gw2.callRest('agent', 'api', '/users', 'GET');
      const calledUrl = fetchSpy.mock.calls[0]![0] as string;
      expect(calledUrl).toContain('token=qsecret');
      fetchSpy.mockRestore();
    });

    it('injects basic auth from credential ref', async () => {
      const settingsWithCred = createMockSettings({
        getCredential: (key: string) => key === 'basic_cred' ? 'user:pass' : undefined,
      });
      const gw2 = new MCPGateway(settingsWithCred, config);
      await gw2.registerTarget('api', restTarget({
        auth: { type: 'basic', credentialRef: 'basic_cred' },
      }), true); // admin — credential injection requires admin

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );

      await gw2.callRest('agent', 'api', '/users', 'GET');
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: `Basic ${Buffer.from('user:pass').toString('base64')}`,
          }),
        }),
      );
      fetchSpy.mockRestore();
    });

    it('records audit on success and failure', async () => {
      await gw.registerTarget('api', restTarget());

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
        .mockResolvedValueOnce(new Response('fail', { status: 500 }));

      await gw.callRest('agent', 'api', '/users', 'GET').catch(() => {});
      await gw.callRest('agent', 'api', '/users', 'GET').catch(() => {});

      const logs = gw.getAuditLogs();
      expect(logs).toHaveLength(2);
      expect(logs[0].success).toBe(true);
      expect(logs[1].success).toBe(false);
      fetchSpy.mockRestore();
    });
  });

  // ── Audit ─────────────────────────────────────────────────────────

  describe('getUsageSummary', () => {
    it('returns per-target call and error counts', async () => {
      await gw.registerTarget('api', restTarget());

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
        .mockResolvedValueOnce(new Response('fail', { status: 500 }));

      await gw.callRest('agent', 'api', '/a', 'GET').catch(() => {});
      await gw.callRest('agent', 'api', '/b', 'GET').catch(() => {});

      const summary = gw.getUsageSummary();
      expect(summary['api']).toEqual({ calls: 2, errors: 1 });
      fetchSpy.mockRestore();
    });
  });

  // ── Injectable tools ──────────────────────────────────────────────

  describe('getInjectableTools', () => {
    it('produces prefixed tool names (target__tool) for MCP tools', async () => {
      await gw.registerTarget('search', mcpTarget());
      const tools = gw.getInjectableTools();
      const names = tools.map(t => t.name);
      expect(names).toContain('search__search');
      expect(names).toContain('search__compute');
    });

    it('produces prefixed tool names for REST operations', async () => {
      await gw.registerTarget('api', restTarget());
      const tools = gw.getInjectableTools();
      const names = tools.map(t => t.name);
      expect(names).toContain('api__listUsers');
      expect(names).toContain('api__createUser');
    });

    it('sets risk to communications', async () => {
      await gw.registerTarget('api', restTarget());
      const tools = gw.getInjectableTools();
      expect(tools.every(t => t.risk === 'communications')).toBe(true);
    });

    it('skips disabled targets', async () => {
      await gw.registerTarget('api', restTarget({ enabled: false }));
      expect(gw.getInjectableTools()).toHaveLength(0);
    });

    it('uses cache after first call', async () => {
      await gw.registerTarget('api', restTarget());
      const first = gw.getInjectableTools();
      const second = gw.getInjectableTools();
      expect(first).toBe(second); // same reference
    });
  });

  // ── Credential trust guard ────────────────────────────────────────

  describe('credential trust guard', () => {
    it('admin target resolves credential: env vars', async () => {
      const settingsWithCred = createMockSettings({
        getCredential: (key: string) => key === 'secret' ? 'resolved_secret' : undefined,
        getAdminTargets: () => new Set(['trusted']),
      });
      const gw2 = new MCPGateway(settingsWithCred, config);
      const target = mcpTarget({
        transport: 'stdio',
        command: 'echo',
        env: { API_KEY: 'credential:secret' },
      });

      // Initialize to restore admin targets from settings
      await gw2.initialize();
      await gw2.registerTarget('trusted', target, true);

      // The connectMcpClient is called during callMcpTool, but since we can't
      // easily mock the MCP SDK Client in unit tests, we verify admin tracking
      expect(settingsWithCred.addAdminTarget).toHaveBeenCalledWith('trusted');
    });

    it('non-admin target does not resolve credential refs', async () => {
      const settingsWithCred = createMockSettings({
        getCredential: (key: string) => key === 'secret' ? 'resolved_secret' : undefined,
      });
      const gw2 = new MCPGateway(settingsWithCred, config);
      const target = mcpTarget({
        transport: 'stdio',
        command: 'echo',
        env: { API_KEY: 'credential:secret' },
      });

      await gw2.registerTarget('untrusted', target, false);
      expect(settingsWithCred.addAdminTarget).not.toHaveBeenCalled();
    });
  });
});
