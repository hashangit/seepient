/**
 * Spec 022 — createGateway inversion test (T006).
 */
import { describe, it, expect, vi } from 'vitest';
import { createGateway } from '../index.js';
import type { GatewayConfig } from '../types.js';
import type { GatewaySettingsAdapter } from '../settings-adapter.js';

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

describe('createGateway inversion (T006)', () => {
  it('returns null when config.enabled is false', async () => {
    const config = { enabled: false } as GatewayConfig;
    const adapter = createMockSettings();
    const result = await createGateway(config, adapter);
    expect(result).toBeNull();
  });

  it('returns { gateway, tools } when config.enabled is true', async () => {
    const config = { enabled: true } as GatewayConfig;
    const adapter = createMockSettings();

    const result = await createGateway(config, adapter);
    expect(result).not.toBeNull();
    expect(result).toHaveProperty('gateway');
    expect(result).toHaveProperty('tools');
    expect(Array.isArray(result!.tools)).toBe(true);
  });
});
