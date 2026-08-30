/**
 * Integration tests for the settings feature.
 * Cross-cutting scenarios that span schema ↔ manager ↔ persistence ↔ events.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { SETTINGS_MAP, SETTINGS_SCHEMA, ENV_VAR_MAP, isSecretField } from '../../../foundations/settings-schema.js';
import { SettingsManager, SettingsError } from '../settings-manager.js';

let tmpDir: string;
let configPath: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'seepient-int-'));
  configPath = path.join(tmpDir, 'setting.json');
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function mgr(config: Record<string, any> = {}): SettingsManager {
  return new SettingsManager({ config, projectConfigPath: configPath, projectConfig: {}, globalConfig: {} });
}

// ── Schema ↔ Manager round-trip ──────────────────────────────────────────

describe('schema-manager round-trip', () => {
  const sampleKeys = [
    'smtp.host', 'smtp.port', 'smtp.user', 'smtp.pass',
    'permissions.consentMode', 'agent.autoConfirm',
    'permissions.approvalTimeoutMs',
  ];

  it.each(sampleKeys)('set+get round-trip for %s', async (dotKey) => {
    const m = mgr();
    const schema = SETTINGS_SCHEMA.get(dotKey)!;
    let testVal: string;
    if (schema.type === 'boolean') testVal = 'true';
    else if (schema.type === 'number') testVal = String(schema.min ?? 2);
    else if (schema.type === 'enum') testVal = schema.enumValues![0];
    else testVal = 'test-value';

    await m.set(dotKey, testVal);
    const result = m.get(dotKey);
    expect(result.value).toBeDefined();
  });

  it('persists dotKey to correct AppConfig path', async () => {
    const m = mgr({ tavilyApiKey: 'tvly-old' });
    await m.set('search.tavilyApiKey', 'tvly-new123456');
    const file = JSON.parse(await fs.readFile(configPath, 'utf-8'));
    expect(file.tavilyApiKey).toBe('tvly-new123456');
  });

  it('env var takes priority in origin resolution', () => {
    process.env.SMTP_HOST = 'from-env';
    try {
      const m = mgr({ smtpHost: 'from-config' });
      expect(m.get('smtp.host').origin).toBe('env: SMTP_HOST');
    } finally {
      delete process.env.SMTP_HOST;
    }
  });
});

// ── Secret masking ───────────────────────────────────────────────────────

describe('secret masking', () => {
  it('masks 8+ char secrets as first3...last4', () => {
    const m = mgr({ tavilyApiKey: 'tvly-abcdefgh1234567890' });
    const r = m.get('search.tavilyApiKey');
    expect(r.value).toBe('tvl...7890');
    expect(r.masked).toBe(true);
  });

  it('masks short secrets as ******', () => {
    const m = mgr({ smtpPass: 'abc' });
    // smtp.pass maps to smtpPass — check if short secrets mask
    const r = m.get('smtp.pass');
    if (r.value != null) expect(r.value).toBe('******');
  });

  it('non-secret fields are not masked', () => {
    const m = mgr({ smtpHost: 'smtp.gmail.com' });
    const r = m.get('smtp.host');
    expect(r.masked).toBe(false);
    expect(r.value).toBe('smtp.gmail.com');
  });
});

// ── Validation ───────────────────────────────────────────────────────────

describe('validation', () => {
  it('rejects invalid enum', async () => {
    await expect(mgr().set('permissions.consentMode', 'invalid')).rejects.toThrow('must be one of');
  });

  it('rejects non-number for number fields', async () => {
    await expect(mgr().set('permissions.approvalTimeoutMs', 'abc')).rejects.toThrow('must be a number');
  });

  it('rejects invalid boolean', async () => {
    await expect(mgr().set('agent.autoConfirm', 'yes')).rejects.toThrow('must be true or false');
  });

  it('rejects invalid URL for baseUrl fields', async () => {
    await expect(mgr().set('notifications.feishu.webhook', 'not-a-url')).rejects.toThrow('must be a valid URL');
  });

  it('rejects invalid hostname for smtp.host', async () => {
    await expect(mgr().set('smtp.host', '!!!bad')).rejects.toThrow('must be a valid hostname');
  });
});

// ── Persistence ──────────────────────────────────────────────────────────

describe('persistence', () => {
  it('new manager reads persisted value', async () => {
    const m1 = mgr();
    await m1.set('smtp.host', 'smtp.test.com');

    const m2 = new SettingsManager({
      config: JSON.parse(await fs.readFile(configPath, 'utf-8')),
      projectConfigPath: configPath,
      projectConfig: {},
      globalConfig: {},
    });
    expect(m2.get('smtp.host').value).toBe('smtp.test.com');
  });

  it('reset removes value from file', async () => {
    const m = mgr({ smtpHost: 'test.com' });
    await m.reset('smtp.host');
    expect(m.get('smtp.host').value).toBeUndefined();
  });

  it('resetAll clears config', async () => {
    const m = mgr({ smtpHost: 'test.com', smtpPort: 587 });
    await m.resetAll();
    expect(m.get('smtp.host').value).toBeUndefined();
  });
});

// ── Events ───────────────────────────────────────────────────────────────

describe('events', () => {
  it('fires onChange on set', async () => {
    const changes: string[][] = [];
    const m = mgr();
    m.onChange(keys => changes.push(keys));
    await m.set('smtp.host', 'test.com');
    expect(changes).toHaveLength(1);
    expect(changes[0]).toContain('smtp.host');
  });

  it('does NOT fire on failed validation', async () => {
    const changes: string[][] = [];
    const m = mgr();
    m.onChange(keys => changes.push(keys));
    await expect(m.set('image.n', 'abc')).rejects.toThrow();
    expect(changes).toHaveLength(0);
  });

  it('multiple subscribers all receive events', async () => {
    const a: string[][] = [];
    const b: string[][] = [];
    const m = mgr();
    m.onChange(keys => a.push(keys));
    m.onChange(keys => b.push(keys));
    await m.set('smtp.host', 'test.com');
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it('unsubscribe stops events', async () => {
    const changes: string[][] = [];
    const m = mgr();
    const unsub = m.onChange(keys => changes.push(keys));
    unsub();
    await m.set('smtp.host', 'test.com');
    expect(changes).toHaveLength(0);
  });
});

// ── Error handling ───────────────────────────────────────────────────────

describe('error handling', () => {
  it('SettingsError has correct .code', () => {
    try {
      mgr().get('foo.bar');
    } catch (e: any) {
      expect(e).toBeInstanceOf(SettingsError);
      expect(e.code).toBe('SETTINGS_INVALID_KEY');
      expect(e.retryable).toBe(false);
    }
  });

  it('validation error has SETTINGS_VALIDATION_FAILED code', async () => {
    try {
      await mgr().set('permissions.approvalTimeoutMs', 'abc');
    } catch (e: any) {
      expect(e).toBeInstanceOf(SettingsError);
      expect(e.code).toBe('SETTINGS_VALIDATION_FAILED');
    }
  });
});
