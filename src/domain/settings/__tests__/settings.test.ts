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
    expect(SETTINGS_MAP.size).toBeGreaterThanOrEqual(18);
    expect(SETTINGS_SCHEMA.size).toBeGreaterThanOrEqual(18);
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
    expect(isSecretField('smtp.pass')).toBe(true);
    expect(isSecretField('search.tavilyApiKey')).toBe(true);
    expect(isSecretField('smtp.host')).toBe(false);
    expect(isSecretField('permissions.consentMode')).toBe(false);
  });

  it('isRestartRequired identifies restart-required fields', () => {
    expect(isRestartRequired('smtp.host')).toBe(false);
    expect(isRestartRequired('permissions.consentMode')).toBe(false);
  });

  it('getSettingsByCategory returns correct keys', () => {
    const permKeys = getSettingsByCategory('permissions');
    expect(permKeys).toContain('permissions.consentMode');
    expect(permKeys).toContain('agent.autoConfirm');
    expect(permKeys).toContain('permissions.autonomousWarned');
    expect(permKeys).toContain('permissions.approvalTimeoutMs');
    expect(permKeys).not.toContain('permissions.autonomousMode');
  });

  it('permissions.approvalTimeoutMs defaults to ten minutes and validates bounds', () => {
    const schema = getSettingSchema('permissions.approvalTimeoutMs');
    expect(schema).toBeDefined();
    expect(schema!.type).toBe('number');
    expect(schema!.default).toBe(600_000);
    expect(schema!.min).toBe(10_000);
    expect(schema!.max).toBe(3_600_000);
    expect(getSettingEntry('permissions.approvalTimeoutMs')!.category).toBe('permissions');
  });

  it('permissions.autonomousWarned is an explicit boolean setting', () => {
    const schema = getSettingSchema('permissions.autonomousWarned');
    expect(schema).toMatchObject({
      type: 'boolean',
      default: false,
      restartRequired: false,
    });
    expect(getSettingEntry('permissions.autonomousWarned')!.category).toBe('permissions');
  });

  it('ENV_VAR_MAP has entries for settings with env var overrides', () => {
    expect(ENV_VAR_MAP.get('smtp.host')).toBe('SMTP_HOST');
    expect(ENV_VAR_MAP.get('permissions.consentMode')).toBe('SEEPIENT_CONSENT_MODE');
    expect(ENV_VAR_MAP.get('permissions.approvalTimeoutMs')).toBe('SEEPIENT_APPROVAL_TIMEOUT_MS');
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
      tavilyApiKey: 'tvly-abcdef1234567890',
    });
    const result = mgr.get('search.tavilyApiKey');
    expect(result.masked).toBe(true);
    expect(result.value).toBe('tvl...7890');
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
    await expect(mgr.set('permissions.consentMode', 'high')).rejects.toThrow(SettingsError);
    await expect(mgr.set('permissions.consentMode', 'high')).rejects.toThrow('must be one of');
  });

  it('set() rejects invalid number values', async () => {
    const mgr = createTestManager();
    await expect(mgr.set('permissions.approvalTimeoutMs', 'abc')).rejects.toThrow(SettingsError);
    await expect(mgr.set('permissions.approvalTimeoutMs', 'abc')).rejects.toThrow('must be a number');
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

  it('permissions.autonomousWarned round-trips correctly', async () => {
    const mgr = createTestManager();
    expect(mgr.get('permissions.autonomousWarned').value).toBe(false);
    await mgr.set('permissions.autonomousWarned', 'true');
    expect(mgr.get('permissions.autonomousWarned').value).toBe(true);
    await mgr.reset('permissions.autonomousWarned');
    expect(mgr.get('permissions.autonomousWarned').value).toBe(false);
  });

  it('set() accepts boolean literals directly (defense in depth)', async () => {
    const mgr = createTestManager();
    await mgr.set('permissions.autonomousWarned', true as any);
    expect(mgr.get('permissions.autonomousWarned').value).toBe(true);
    await mgr.set('permissions.autonomousWarned', false as any);
    expect(mgr.get('permissions.autonomousWarned').value).toBe(false);
  });

  it('set() rejects when persistence fails rather than silently resolving', async () => {
    // Config path pointing to an invalid/unwritable location (e.g. /dev/null/config.json)
    const mgr = new SettingsManager({
      config: {},
      projectConfigPath: '/dev/null/invalid/config.json',
      globalConfigPath: '/dev/null/invalid/config.json',
    });
    await expect(mgr.set('permissions.autonomousWarned', 'true')).rejects.toThrow();
  });

  it('setting permissions.autonomousMode throws SETTINGS_INVALID_KEY', async () => {
    const mgr = createTestManager();
    await expect(mgr.set('permissions.autonomousMode', 'true')).rejects.toThrow(
      /Unknown setting: permissions\.autonomousMode/,
    );
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
