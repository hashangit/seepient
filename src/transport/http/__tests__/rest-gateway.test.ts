import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createGatewayRestHandler } from '../rest-gateway.js';
import type { MCPGateway } from '../../../capabilities/gateway/gateway.js';
import type { GatewaySettingsAdapter } from '../../../capabilities/gateway/settings-adapter.js';
import type { Target } from '../../../capabilities/gateway/types.js';
import type { IncomingMessage, ServerResponse } from 'http';

// ── Mock auth ─────────────────────────────────────────────────────────

vi.mock('../../auth/auth.js', () => ({
  authMiddleware: vi.fn(() => ({ key: 'sk_test', scopes: ['admin', 'agent:read', 'agent:run'] })),
  hasScope: vi.fn(() => true),
}));

import { authMiddleware, hasScope } from '../../auth/auth.js';

// ── Helpers ───────────────────────────────────────────────────────────

function createMockGateway(): MCPGateway {
  const targets: Record<string, Target> = {};
  const routes: Array<{ pattern: string; target: string; priority: number }> = [];

  return {
    getTargets: () => targets,
    getAuditLogs: vi.fn(() => []),
    getUsageSummary: vi.fn(() => ({})),
    registerTarget: vi.fn(async (name: string, t: Target) => { targets[name] = t; }),
    unregisterTarget: vi.fn(async (name: string) => !!delete targets[name]),
    toggleTarget: vi.fn(async () => true),
    addRoute: vi.fn(async (pattern: string, target: string, priority: number) => {
      routes.push({ pattern, target, priority });
    }),
    getRoutes: () => routes,
  } as unknown as MCPGateway;
}

function createMockSettings(): GatewaySettingsAdapter {
  return {
    listCredentialKeys: vi.fn(() => ['api_key']),
    setCredential: vi.fn(async () => {}),
    deleteCredential: vi.fn(async () => {}),
  } as unknown as GatewaySettingsAdapter;
}

function mockReq(method: string, path: string, body?: unknown, headers?: Record<string, string>): IncomingMessage {
  const chunks: Buffer[] = [];
  if (body) chunks.push(Buffer.from(JSON.stringify(body)));

  const listeners: Record<string, Array<(...args: any[]) => void>> = {};

  return {
    method,
    url: path,
    headers: { host: 'localhost', ...headers },
    on: (event: string, handler: (...args: any[]) => void) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(handler);
      // Immediately fire data events for already-buffered chunks
      if (event === 'data') chunks.forEach(c => handler(c));
    },
    emit: (event: string, ...args: any[]) => {
      (listeners[event] ?? []).forEach(h => h(...args));
    },
  } as unknown as IncomingMessage;
}

function mockRes(): ServerResponse & { _statusCode: number; _body: string; _json: () => any } {
  let statusCode = 0;
  let responseBody = '';

  const res = {
    _statusCode: 0,
    _body: '',
    _json: () => JSON.parse(responseBody),
    writeHead: (code: number, _hdrs?: Record<string, string>) => {
      statusCode = code;
      res._statusCode = code;
    },
    end: (data?: string | Buffer) => {
      responseBody = typeof data === 'string' ? data : '';
      res._body = responseBody;
    },
  } as unknown as ServerResponse & { _statusCode: number; _body: string; _json: () => any };

  return res;
}

function createHandler() {
  const gateway = createMockGateway();
  const settingsAdapter = createMockSettings();
  const importOpenApiSpec = (async () => ({ ok: true })) as any;
  const handler = createGatewayRestHandler({ gateway, settingsAdapter, importOpenApiSpec });
  return { handler, gateway, settingsAdapter };
}

// Helper: fire 'end' on the mock req after a short delay to let parseBody resolve
function fireEnd(req: IncomingMessage) {
  const anyReq = req as any;
  if (anyReq.emit) anyReq.emit('end');
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('REST gateway handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (authMiddleware as ReturnType<typeof vi.fn>).mockReturnValue(
      { key: 'sk_test', scopes: ['admin', 'agent:read', 'agent:run'] },
    );
    (hasScope as ReturnType<typeof vi.fn>).mockReturnValue(true);
  });

  // ── Route matching (no body needed) ──────────────────────────────

  it('GET /v1/gateway/targets → list_targets', async () => {
    const { handler } = createHandler();
    const req = mockReq('GET', '/v1/gateway/targets');
    const res = mockRes();
    await handler(req, res, '/v1/gateway/targets', 'GET');
    expect(res._statusCode).toBe(200);
    expect(res._json()).toEqual({ targets: {} });
  });

  it('GET /v1/gateway/audit → audit logs', async () => {
    const { handler } = createHandler();
    const req = mockReq('GET', '/v1/gateway/audit');
    const res = mockRes();
    await handler(req, res, '/v1/gateway/audit', 'GET');
    expect(res._statusCode).toBe(200);
    expect(res._json()).toEqual({ logs: [] });
  });

  it('GET /v1/gateway/usage → usage summary', async () => {
    const { handler } = createHandler();
    const req = mockReq('GET', '/v1/gateway/usage');
    const res = mockRes();
    await handler(req, res, '/v1/gateway/usage', 'GET');
    expect(res._statusCode).toBe(200);
    expect(res._json()).toEqual({ usage: {} });
  });

  it('GET /v1/gateway/credentials → credential keys', async () => {
    const { handler } = createHandler();
    const req = mockReq('GET', '/v1/gateway/credentials');
    const res = mockRes();
    await handler(req, res, '/v1/gateway/credentials', 'GET');
    expect(res._statusCode).toBe(200);
    expect(res._json()).toEqual({ keys: ['api_key'] });
  });

  // ── Auth ──────────────────────────────────────────────────────────

  it('returns 401 when no API key provided', async () => {
    (authMiddleware as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const { handler } = createHandler();
    const req = mockReq('GET', '/v1/gateway/targets');
    const res = mockRes();
    await handler(req, res, '/v1/gateway/targets', 'GET');
    expect(res._statusCode).toBe(401);
    expect(res._json().error.code).toBe('UNAUTHORIZED');
  });

  it('agent:read scope is sufficient for list targets', async () => {
    (hasScope as ReturnType<typeof vi.fn>).mockImplementation(
      (_entry: any, scope: string) => scope === 'agent:read',
    );
    const { handler } = createHandler();
    const req = mockReq('GET', '/v1/gateway/targets');
    const res = mockRes();
    await handler(req, res, '/v1/gateway/targets', 'GET');
    expect(res._statusCode).toBe(200);
  });

  it('admin scope required for register target', async () => {
    (hasScope as ReturnType<typeof vi.fn>).mockImplementation(
      (_entry: any, scope: string) => scope === 'agent:read',
    );
    const { handler } = createHandler();
    const req = mockReq('POST', '/v1/gateway/targets', { name: 'test', target: { kind: 'rest' } });
    const res = mockRes();
    const promise = handler(req, res, '/v1/gateway/targets', 'POST');
    fireEnd(req);
    await promise;
    expect(res._statusCode).toBe(403);
  });

  // ── Management endpoints (body needed) ────────────────────────────

  it('PATCH toggle target → 200 on success', async () => {
    const { handler, gateway } = createHandler();
    const req = mockReq('PATCH', '/v1/gateway/targets/myapi/toggle', { enabled: false });
    const res = mockRes();
    const promise = handler(req, res, '/v1/gateway/targets/myapi/toggle', 'PATCH');
    fireEnd(req);
    await promise;
    expect(res._statusCode).toBe(200);
    expect(gateway.toggleTarget).toHaveBeenCalledWith('myapi', false);
  });

  it('POST register target → validates name + target', async () => {
    const { handler } = createHandler();
    const req = mockReq('POST', '/v1/gateway/targets', { name: '' });
    const res = mockRes();
    const promise = handler(req, res, '/v1/gateway/targets', 'POST');
    fireEnd(req);
    await promise;
    expect(res._statusCode).toBe(400);
    expect(res._json().error.message).toContain("'name' and 'target'");
  });

  it('POST add route → validates pattern + target', async () => {
    const { handler } = createHandler();
    const req = mockReq('POST', '/v1/gateway/routes', { pattern: '' });
    const res = mockRes();
    const promise = handler(req, res, '/v1/gateway/routes', 'POST');
    fireEnd(req);
    await promise;
    expect(res._statusCode).toBe(400);
    expect(res._json().error.message).toContain("'pattern' and 'target'");
  });

  it('POST import-openapi → validates name + specUrl', async () => {
    const { handler } = createHandler();
    const req = mockReq('POST', '/v1/gateway/import-openapi', { name: '' });
    const res = mockRes();
    const promise = handler(req, res, '/v1/gateway/import-openapi', 'POST');
    fireEnd(req);
    await promise;
    expect(res._statusCode).toBe(400);
    expect(res._json().error.message).toContain("'name' and 'specUrl'");
  });

  it('returns 404 for unknown gateway path', async () => {
    const { handler } = createHandler();
    const req = mockReq('GET', '/v1/gateway/nonexistent');
    const res = mockRes();
    await handler(req, res, '/v1/gateway/nonexistent', 'GET');
    expect(res._statusCode).toBe(404);
    expect(res._json().error.code).toBe('NOT_FOUND');
  });
});
