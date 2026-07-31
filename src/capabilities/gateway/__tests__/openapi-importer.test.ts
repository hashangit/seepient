import { describe, it, expect, vi, beforeEach } from 'vitest';
import { importOpenApiSpec } from '../openapi-importer.js';
import type { MCPGateway } from '../gateway.js';

// ── Helpers ───────────────────────────────────────────────────────────

function createMockGateway(): MCPGateway {
  return {
    registerTarget: vi.fn(async () => {}),
  } as unknown as MCPGateway;
}

function openApiJson(overrides?: { servers?: any[]; paths?: Record<string, any>; info?: any }): string {
  const spec: any = {
    openapi: '3.0.0',
    info: { title: 'Test API', version: '1.0.0', ...overrides?.info },
    servers: overrides?.servers ?? [{ url: 'https://api.example.com' }],
    paths: overrides?.paths ?? {
      '/users': {
        get: { operationId: 'listUsers', summary: 'List users', tags: ['users'] },
        post: { operationId: 'createUser', summary: 'Create user', tags: ['users'] },
      },
      '/orders': {
        get: { operationId: 'listOrders', summary: 'List orders', tags: ['orders'] },
      },
    },
  };
  return JSON.stringify(spec);
}

function openApiYaml(): string {
  return `
openapi: '3.0.0'
info:
  title: YAML API
  version: '1.0.0'
servers:
  - url: https://yaml.example.com
paths:
  /items:
    get:
      operationId: listItems
      summary: List items
      tags:
        - items
`;
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('importOpenApiSpec', () => {
  let gateway: MCPGateway;

  beforeEach(() => {
    gateway = createMockGateway();
  });

  it('parses JSON spec and extracts operations', async () => {
    const spec = openApiJson();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(spec, { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    const result = await importOpenApiSpec(gateway, 'test-api', 'https://spec.example.com/openapi.json');

    expect(result.imported).toBe(3);
    expect(result.operations).toContain('listUsers');
    expect(result.operations).toContain('createUser');
    expect(result.operations).toContain('listOrders');
    expect(gateway.registerTarget).toHaveBeenCalledWith('test-api', expect.objectContaining({ kind: 'rest' }), true);
  });

  it('parses YAML spec and extracts operations', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(openApiYaml(), { status: 200, headers: { 'Content-Type': 'application/yaml' } }),
    );

    const result = await importOpenApiSpec(gateway, 'yaml-api', 'https://spec.example.com/openapi.yaml');

    expect(result.imported).toBe(1);
    expect(result.operations).toContain('listItems');
  });

  it('throws when no base URL found and none provided', async () => {
    const spec = openApiJson({ servers: [] });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(spec, { status: 200 }),
    );

    await expect(importOpenApiSpec(gateway, 'no-base', 'https://spec.example.com/openapi.json'))
      .rejects.toThrow('No base URL found');
  });

  it('applies tag filter correctly', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(openApiJson(), { status: 200 }),
    );

    const result = await importOpenApiSpec(gateway, 'filtered', 'https://spec.example.com/openapi.json', {
      tagFilter: ['users'],
    });

    expect(result.imported).toBe(2);
    expect(result.operations).toContain('listUsers');
    expect(result.operations).toContain('createUser');
    expect(result.operations).not.toContain('listOrders');
  });

  it('registers target on gateway with extracted data', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(openApiJson(), { status: 200 }),
    );

    await importOpenApiSpec(gateway, 'myapi', 'https://spec.example.com/openapi.json');

    const call = (gateway.registerTarget as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe('myapi');
    const target = call[1] as any;
    expect(target.baseUrl).toBe('https://api.example.com');
    expect(target.description).toBe('Test API');
    expect(target.tags).toEqual(expect.arrayContaining(['users', 'orders']));
    expect(target.enabled).toBe(true);
  });

  it('handles HTTP fetch error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Not Found', { status: 404 }),
    );

    await expect(importOpenApiSpec(gateway, 'fail', 'https://spec.example.com/missing.json'))
      .rejects.toThrow('Failed to fetch spec: HTTP 404');
  });
});
