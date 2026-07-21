import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { GatewaySettingsAdapter } from '../settings-adapter.js';

const TEST_DIR = path.join(process.cwd(), '.test-gateway-' + process.pid);

describe('GatewaySettingsAdapter', () => {
  let adapter: GatewaySettingsAdapter;

  beforeEach(async () => {
    adapter = new GatewaySettingsAdapter(TEST_DIR);
    await adapter.initialize();
  });

  afterEach(async () => {
    await fs.rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
  });

  it('loads empty state when no files exist', () => {
    expect(adapter.getTargets()).toEqual({});
    expect(adapter.listCredentialKeys()).toEqual([]);
    expect(adapter.getRoutes()).toEqual([]);
  });

  it('saves and reloads a target', async () => {
    await adapter.saveTarget('test', {
      kind: 'rest',
      baseUrl: 'https://api.example.com',
      description: 'Test API',
      auth: { type: 'none' },
      defaultHeaders: {},
      operations: [],
      tags: ['test'],
      enabled: true,
    });
    const adapter2 = new GatewaySettingsAdapter(TEST_DIR);
    await adapter2.initialize();
    expect(adapter2.getTargets()['test']).toBeDefined();
    expect(adapter2.getTargets()['test'].kind).toBe('rest');
  });

  it('saves and retrieves credentials', async () => {
    await adapter.setCredential('api_key', 'sk_test_123');
    expect(adapter.getCredential('api_key')).toBe('sk_test_123');
  });

  it('deletes a credential', async () => {
    await adapter.setCredential('api_key', 'sk_test');
    await adapter.deleteCredential('api_key');
    expect(adapter.getCredential('api_key')).toBeUndefined();
  });

  it('saves and loads routes', async () => {
    await adapter.saveRoutes([{ pattern: 'payment', target: 'stripe', priority: 1 }]);
    const adapter2 = new GatewaySettingsAdapter(TEST_DIR);
    await adapter2.initialize();
    expect(adapter2.getRoutes()).toHaveLength(1);
    expect(adapter2.getRoutes()[0].pattern).toBe('payment');
  });
});
