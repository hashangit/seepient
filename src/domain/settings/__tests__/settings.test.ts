/**
 * Unit tests for settings-schema.ts and settings-manager.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  SETTINGS_MAP,
  SETTINGS_SCHEMA,
  ENV_VAR_MAP,
  CONFIG_PATH_TO_DOTKEY,
  SETTINGS_CATEGORIES,
  getSettingEntry,
  getSettingSchema,
  getDotKeyForConfigPath,
  isSecretField,
  isRestartRequired,
  getSettingsByCategory,
} from '../../../foundations/settings-schema.js';
import { SettingsManager, SettingsError } from '../settings-manager.js';

// ── Schema tests ──────────────────────────────────────────────────────────

describe('settings-schema', () => {
  it('has entries for all expected settings', () => {
    // At minimum: 10 provider + 7 image + 5 smtp + 1 search + 6 notifications + 2 agent = 31
    expect(SETTINGS_MAP.size).toBeGreaterThanOrEqual(30);
    expect(SETTINGS_SCHEMA.size).toBeGreaterThanOrEqual(30);
  });

  it('every SETTINGS_MAP entry has a corresponding SETTINGS_SCHEMA entry', () => {
    for (const [dotKey] of SETTINGS_MAP) {
      expect(SETTINGS_SCHEMA.has(dotKey), `Missing schema for ${dotKey}`).toBe(true);
    }
  });

  it('every SETTINGS_SCHEMA entry has a corresponding SETTINGS_MAP entry', () => {
    for (const [dotKey] of SETTINGS_SCHEMA) {
      expect(SETTINGS_MAP.has(dotKey), `Missing map entry for ${dotKey}`).toBe(true);
    }
  });

  it('CONFIG_PATH_TO_DOTKEY is the inverse of SETTINGS_MAP configPath', () => {
    for (const [dotKey, entry] of SETTINGS_MAP) {
      const pathKey = entry.configPath.join('.');
      expect(CONFIG_PATH_TO_DOTKEY.get(pathKey), `Reverse lookup for ${pathKey}`).toBe(dotKey);
    }
  });

  it('every entry has a valid category', () => {
    const validCategories = new Set(SETTINGS_CATEGORIES.map(c => c.key));
    for (const [dotKey, entry] of SETTINGS_MAP) {
      expect(validCategories.has(entry.category), `Invalid category for ${dotKey}: ${entry.category}`).toBe(true);
    }
  });

  it('getSettingEntry returns correct entry', () => {
    const entry = getSettingEntry('smtp.host');
    expect(entry).toBeDefined();
    expect(entry!.dotKey).toBe('smtp.host');
    expect(entry!.configPath).toEqual(['smtpHost']);
  });

  it('getSettingEntry returns undefined for unknown key', () => {
    expect(getSettingEntry('foo.bar')).toBeUndefined();
  });

  it('isSecretField identifies secret fields', () => {
    expect(isSecretField('providers.openai.apiKey')).toBe(true);
    expect(isSecretField('smtp.pass')).toBe(true);
    expect(isSecretField('search.tavilyApiKey')).toBe(true);
    expect(isSecretField('smtp.host')).toBe(false);
    expect(isSecretField('agent.permissionLevel')).toBe(false);
  });

  it('isRestartRequired identifies restart-required fields', () => {
    expect(isRestartRequired('providers.openai.apiKey')).toBe(true);
    expect(isRestartRequired('provider')).toBe(true);
    expect(isRestartRequired('smtp.host')).toBe(false);
    expect(isRestartRequired('agent.permissionLevel')).toBe(false);
  });

  it('getSettingsByCategory returns correct keys', () => {
    const permKeys = getSettingsByCategory('permissions');
    expect(permKeys).toContain('agent.permissionLevel');
    expect(permKeys).toContain('agent.autoConfirm');

    const providerKeys = getSettingsByCategory('providers');
    expect(providerKeys.length).toBeGreaterThanOrEqual(8);
  });

  it('ENV_VAR_MAP has entries for settings with env var overrides', () => {
    expect(ENV_VAR_MAP.get('providers.openai.apiKey')).toBe('OPENAI_API_KEY');
    expect(ENV_VAR_MAP.get('smtp.host')).toBe('SMTP_HOST');
    expect(ENV_VAR_MAP.get('agent.permissionLevel')).toBe('SEEPIENT_PERMISSION');
  });

  it('provider dot-keys map to correct AppConfig paths', () => {
    const openai = getSettingEntry('providers.openai.apiKey');
    expect(openai!.configPath).toEqual(['models', 'openai', 'apiKey']);

    const compat = getSettingEntry('providers.openai-compat.baseUrl');
    expect(compat!.configPath).toEqual(['models', 'openai-compatible', 'baseUrl']);
  });
});

// ── Manager tests ─────────────────────────────────────────────────────────

describe('SettingsManager', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'seepient-test-'));
    configPath = path.join(tmpDir, 'setting.json');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function createTestManager(config: Record<string, any> = {}): SettingsManager {
    return new SettingsManager({
      config,
      projectConfigPath: configPath,
      projectConfig: {},
      globalConfig: {},
    });
  }

  it('get() returns value from in-memory config', () => {
    const mgr = createTestManager({ smtpHost: 'smtp.gmail.com' });
    const result = mgr.get('smtp.host');
    expect(result.value).toBe('smtp.gmail.com');
  });

  it('get() masks secret fields', () => {
    const mgr = createTestManager({
      models: { openai: { apiKey: 'sk-abcdef1234567890' } },
    });
    const result = mgr.get('providers.openai.apiKey');
    expect(result.masked).toBe(true);
    expect(result.value).toBe('sk-...7890');
  });

  it('get() throws SettingsError for unknown key', () => {
    const mgr = createTestManager();
    expect(() => mgr.get('foo.bar')).toThrow(SettingsError);
    expect(() => mgr.get('foo.bar')).toThrow('Unknown setting');
  });

  it('get() returns (not set) for undefined values', () => {
    const mgr = createTestManager();
    const result = mgr.get('smtp.host');
    expect(result.value).toBeUndefined();
  });

  it('set() validates and persists a value', async () => {
    const mgr = createTestManager();
    await mgr.set('smtp.host', 'smtp.gmail.com');

    const result = mgr.get('smtp.host');
    expect(result.value).toBe('smtp.gmail.com');

    // Check persisted to file
    const content = JSON.parse(await fs.readFile(configPath, 'utf-8'));
    expect(content.smtpHost).toBe('smtp.gmail.com');
  });

  it('set() rejects invalid enum values', async () => {
    const mgr = createTestManager();
    await expect(mgr.set('agent.permissionLevel', 'high')).rejects.toThrow(SettingsError);
    await expect(mgr.set('agent.permissionLevel', 'high')).rejects.toThrow('must be one of');
  });

  it('set() rejects invalid number values', async () => {
    const mgr = createTestManager();
    await expect(mgr.set('image.n', 'abc')).rejects.toThrow(SettingsError);
    await expect(mgr.set('image.n', 'abc')).rejects.toThrow('must be a number');
  });

  it('set() rejects invalid boolean values', async () => {
    const mgr = createTestManager();
    await expect(mgr.set('agent.autoConfirm', 'yes')).rejects.toThrow(SettingsError);
  });

  it('set() accepts valid boolean values', async () => {
    const mgr = createTestManager();
    await mgr.set('agent.autoConfirm', 'true');
    expect(mgr.get('agent.autoConfirm').value).toBe(true);
  });

  it('set() rejects unknown keys', async () => {
    const mgr = createTestManager();
    await expect(mgr.set('foo.bar', 'baz')).rejects.toThrow(SettingsError);
  });

  it('list() returns all settings with metadata', () => {
    const mgr = createTestManager({ smtpHost: 'test.com' });
    const list = mgr.list();
    expect(list.length).toBe(SETTINGS_MAP.size);
    expect(list.find(s => s.dotKey === 'smtp.host')?.value).toBe('test.com');
  });

  it('listByCategory() groups by category', () => {
    const mgr = createTestManager();
    const grouped = mgr.listByCategory();
    expect(Object.keys(grouped)).toContain('providers');
    expect(Object.keys(grouped)).toContain('permissions');
    expect(grouped.permissions.length).toBeGreaterThanOrEqual(2);
  });

  it('reset() removes a value', async () => {
    const mgr = createTestManager({ smtpHost: 'test.com' });
    await mgr.reset('smtp.host');
    const result = mgr.get('smtp.host');
    expect(result.value).toBeUndefined();
  });

  it('onChange callback fires on set()', async () => {
    const mgr = createTestManager();
    const changes: string[][] = [];
    mgr.onChange((keys) => changes.push(keys));

    await mgr.set('smtp.host', 'test.com');
    expect(changes).toHaveLength(1);
    expect(changes[0]).toContain('smtp.host');
  });

  it('onChange returns unsubscribe function', async () => {
    const mgr = createTestManager();
    const changes: string[][] = [];
    const unsub = mgr.onChange((keys) => changes.push(keys));

    unsub();
    await mgr.set('smtp.host', 'test.com');
    expect(changes).toHaveLength(0);
  });

  it('deep merge preserves sibling provider config', async () => {
    const mgr = createTestManager({
      models: {
        openai: { apiKey: 'sk-openai-key', model: 'gpt-5.4' },
        anthropic: { apiKey: 'sk-ant-key', model: 'claude-sonnet' },
      },
    });

    await mgr.set('providers.openai.model', 'gpt-4o');

    // Anthropic config should be preserved
    const anthropicKey = mgr.get('providers.anthropic.apiKey');
    expect(anthropicKey.value).toBe('sk-...-key');
  });

  it('origin resolution checks env vars', () => {
    process.env.SMTP_HOST = 'from-env';
    try {
      const mgr = createTestManager({ smtpHost: 'from-config' });
      const result = mgr.get('smtp.host');
      expect(result.origin).toBe('env: SMTP_HOST');
    } finally {
      delete process.env.SMTP_HOST;
    }
  });

  it('origin resolution falls back to default', () => {
    const mgr = createTestManager();
    const result = mgr.get('smtp.host');
    expect(result.origin).toBe('default');
  });

  it('get() returns schema default when config has no value', () => {
    const mgr = createTestManager();
    const result = mgr.get('gateway.enabled');
    expect(result.value).toBe(true);
    expect(result.origin).toBe('default');
  });

  it('get() ignores empty-string env var and falls back to default', () => {
    process.env.SEEPIENT_GATEWAY_ENABLED = '';
    try {
      const mgr = createTestManager();
      const result = mgr.get('gateway.enabled');
      expect(result.value).toBe(true);
      expect(result.origin).toBe('default');
    } finally {
      delete process.env.SEEPIENT_GATEWAY_ENABLED;
    }
  });

  it('get() respects explicit false env var', () => {
    process.env.SEEPIENT_GATEWAY_ENABLED = 'false';
    try {
      const mgr = createTestManager();
      const result = mgr.get('gateway.enabled');
      expect(result.value).toBe(false);
      expect(result.origin).toBe('env: SEEPIENT_GATEWAY_ENABLED');
    } finally {
      delete process.env.SEEPIENT_GATEWAY_ENABLED;
    }
  });
});
