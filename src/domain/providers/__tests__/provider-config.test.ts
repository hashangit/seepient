/**
 * Unit tests for loadProviderConfig() — the AppConfig → MultiProviderConfig bridge.
 *
 * loadProviderConfig() reads from real config files + env vars via loadMergedConfig()
 * and applyEnvOverrides(). We mock those two (plus resolveActiveProviderType) so the
 * tests exercise the translation logic in isolation, not the filesystem.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock the config.ts dependencies of provider-config.ts ────────────
// provider-config.ts imports { loadMergedConfig, applyEnvOverrides, resolveActiveProviderType }
// from ./config.js. We control all three so tests are deterministic.

const mockLoadMergedConfig = vi.fn();
const mockApplyEnvOverrides = vi.fn();
const mockResolveActiveProviderType = vi.fn();

vi.mock('../../../foundations/config.js', () => ({
  loadMergedConfig: (...args: unknown[]) => mockLoadMergedConfig(...args),
  applyEnvOverrides: (...args: unknown[]) => mockApplyEnvOverrides(...args),
  resolveActiveProviderType: (...args: unknown[]) => mockResolveActiveProviderType(...args),
}));

// Import AFTER the mock is registered.
import { loadProviderConfig } from '../provider-config.js';

// applyEnvOverrides returns its argument in production; mirror that so tests
// can pass an AppConfig via mockLoadMergedConfig and have it flow through.
beforeEach(() => {
  mockLoadMergedConfig.mockReset();
  mockApplyEnvOverrides.mockReset();
  mockResolveActiveProviderType.mockReset();
  mockApplyEnvOverrides.mockImplementation((c: unknown) => c);
});

// ── Tests ─────────────────────────────────────────────────────────────

describe('loadProviderConfig', () => {
  it('returns null when no providers are configured', () => {
    mockLoadMergedConfig.mockReturnValue({});
    expect(loadProviderConfig()).toBeNull();
  });

  it('returns null when models map exists but has no apiKey entries', () => {
    mockLoadMergedConfig.mockReturnValue({ models: {} });
    expect(loadProviderConfig()).toBeNull();
  });

  it('flattens a single provider from the models map', () => {
    mockLoadMergedConfig.mockReturnValue({
      models: { openai: { apiKey: 'sk-test', model: 'gpt-4o' } },
    });
    mockResolveActiveProviderType.mockReturnValue('openai');

    const result = loadProviderConfig();
    expect(result).not.toBeNull();
    expect(result!.openai).toEqual({ apiKey: 'sk-test', model: 'gpt-4o' });
    expect(result!.default).toBe('openai');
  });

  it('includes all configured providers', () => {
    mockLoadMergedConfig.mockReturnValue({
      models: {
        openai: { apiKey: 'sk-openai', model: 'gpt-4o' },
        anthropic: { apiKey: 'sk-ant', model: 'claude-3' },
      },
    });
    mockResolveActiveProviderType.mockReturnValue('openai');

    const result = loadProviderConfig();
    expect(result!.openai).toBeDefined();
    expect(result!.anthropic).toBeDefined();
    expect(Object.keys(result!).filter((k) => k !== 'default')).toHaveLength(2);
  });

  it('uses config.provider as default when it is in the collected set', () => {
    mockLoadMergedConfig.mockReturnValue({
      provider: 'anthropic',
      models: {
        openai: { apiKey: 'sk-openai', model: 'gpt-4o' },
        anthropic: { apiKey: 'sk-ant', model: 'claude-3' },
      },
    });
    // Even if resolveActiveProviderType returns something else, config.provider wins.
    mockResolveActiveProviderType.mockReturnValue('openai');

    const result = loadProviderConfig();
    expect(result!.default).toBe('anthropic');
  });

  it('falls back to first collected provider when resolved default is not in set', () => {
    // resolveActiveProviderType returns 'glm' but only openai is configured.
    mockLoadMergedConfig.mockReturnValue({
      models: { openai: { apiKey: 'sk-openai', model: 'gpt-4o' } },
    });
    mockResolveActiveProviderType.mockReturnValue('glm');

    const result = loadProviderConfig();
    // default must point at a real entry — 'openai' is the only one collected.
    expect(result!.default).toBe('openai');
  });

  it('includes baseUrl for openai-compatible entries', () => {
    mockLoadMergedConfig.mockReturnValue({
      models: {
        'openai-compatible': {
          apiKey: 'sk-compat',
          baseUrl: 'https://custom.api/v1',
          model: 'gpt-4o',
        },
      },
    });
    mockResolveActiveProviderType.mockReturnValue('openai-compatible');

    const result = loadProviderConfig();
    expect(result!['openai-compatible']).toEqual({
      apiKey: 'sk-compat',
      baseUrl: 'https://custom.api/v1',
      model: 'gpt-4o',
    });
  });

  it('skips provider entries with no apiKey', () => {
    mockLoadMergedConfig.mockReturnValue({
      models: {
        openai: { apiKey: '', model: 'gpt-4o' },
        anthropic: { apiKey: 'sk-ant', model: 'claude-3' },
      },
    });
    mockResolveActiveProviderType.mockReturnValue('anthropic');

    const result = loadProviderConfig();
    // openai dropped (empty apiKey), only anthropic remains
    expect(result!.openai).toBeUndefined();
    expect(result!.anthropic).toBeDefined();
    expect(result!.default).toBe('anthropic');
  });

  it('result composes with configureProviders (shape check)', async () => {
    // Verifies the core motivation for this function: the returned object
    // is a valid MultiProviderConfig that configureProviders() will accept
    // and getDefaultProviderType() will honor.
    const { configureProviders, getDefaultProviderType } = await import('../provider-config.js');

    mockLoadMergedConfig.mockReturnValue({
      provider: 'glm',
      models: { glm: { apiKey: 'sk-glm', model: 'glm-4.5' } },
    });
    mockResolveActiveProviderType.mockReturnValue('glm');

    const config = loadProviderConfig()!;
    configureProviders(config);
    expect(getDefaultProviderType()).toBe('glm');
  });
});
