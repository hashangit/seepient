/**
 * Seepient Core — Settings Manager
 *
 * Single source of truth for reading, writing, validating, and persisting
 * settings. Adapters (CLI, SDK, Server) delegate to this class.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { SeepientError } from '../../foundations/errors.js';
import '../../domain/providers/model-catalog.js';
import {
  SETTINGS_MAP,
  SETTINGS_SCHEMA,
  ENV_VAR_MAP,
  SettingsMapEntry,
  SettingsSchemaEntry,
  isSecretField,
  isRestartRequired,
  getSettingsByCategory,
  SettingsCategory,
} from '../../foundations/settings-schema.js';

// ── Settings Error ────────────────────────────────────────────────────────

export class SettingsError extends SeepientError {
  constructor(message: string, code = 'SETTINGS_ERROR') {
    super(message, code, false);
    this.name = 'SettingsError';
  }
}

// ── Types ─────────────────────────────────────────────────────────────────

export interface SettingValue {
  value: unknown;
  origin: string;
  masked: boolean;
}

export interface SettingEntry extends SettingValue {
  dotKey: string;
  category: SettingsCategory;
  restartRequired: boolean;
  label: string;
}

export interface SettingsManagerOptions {
  config: Record<string, any>;
  projectConfigPath?: string;
  globalConfigPath?: string;
  projectConfig?: Record<string, any>;
  globalConfig?: Record<string, any>;
}

// ── SettingsManager ───────────────────────────────────────────────────────

export class SettingsManager {
  private config: Record<string, any>;
  private projectConfigPath?: string;
  private globalConfigPath?: string;
  private projectConfig: Record<string, any>;
  private globalConfig: Record<string, any>;
  private listeners: Array<(changedKeys: string[]) => void> = [];

  constructor(options: SettingsManagerOptions) {
    this.config = { ...options.config };
    this.projectConfigPath = options.projectConfigPath;
    this.globalConfigPath = options.globalConfigPath;
    this.projectConfig = options.projectConfig ?? {};
    this.globalConfig = options.globalConfig ?? {};
  }

  // ── Read ───────────────────────────────────────────────────────────────

  get(dotKey: string): SettingValue {
    const entry = SETTINGS_MAP.get(dotKey);
    if (!entry) {
      throw new SettingsError(`Unknown setting: ${dotKey}. Use /settings list to see available keys.`, 'SETTINGS_INVALID_KEY');
    }

    const schema = SETTINGS_SCHEMA.get(dotKey);
    const secret = isSecretField(dotKey);

    // Check env var first (empty string = not explicitly set → fall through to default)
    const envVar = ENV_VAR_MAP.get(dotKey);
    if (envVar && process.env[envVar]) {
      const raw = this.parseEnvValue(process.env[envVar], schema);
      const value = secret && raw != null ? this.maskValue(String(raw)) : raw;
      return { value, origin: `env: ${envVar}`, masked: secret };
    }

    // Check config, falling back to schema default
    const raw = this.getValueByPath(this.config, entry.configPath);
    const effectiveValue = raw ?? schema?.default;
    const value = secret && effectiveValue != null ? this.maskValue(String(effectiveValue)) : effectiveValue;
    const origin = raw !== undefined && raw !== null
      ? this.resolveConfigOrigin(entry.configPath)
      : schema?.default !== undefined ? 'default' : 'default';

    return { value, origin, masked: secret };
  }

  list(): SettingEntry[] {
    const results: SettingEntry[] = [];
    for (const [dotKey, mapEntry] of SETTINGS_MAP) {
      const schema = SETTINGS_SCHEMA.get(dotKey);
      const { value, origin, masked } = this.get(dotKey);
      results.push({
        dotKey,
        value,
        origin,
        masked,
        category: mapEntry.category,
        restartRequired: schema?.restartRequired ?? false,
        label: mapEntry.label,
      });
    }
    return results;
  }

  listByCategory(): Record<string, SettingEntry[]> {
    const result: Record<string, SettingEntry[]> = {};
    for (const entry of this.list()) {
      if (!result[entry.category]) result[entry.category] = [];
      result[entry.category].push(entry);
    }
    return result;
  }

  // ── Write ──────────────────────────────────────────────────────────────

  async set(dotKey: string, rawValue: unknown): Promise<void> {
    return this.setValue(dotKey, rawValue);
  }

  private async setValue(dotKey: string, rawValue: unknown): Promise<void> {
    const mapEntry = SETTINGS_MAP.get(dotKey);
    if (!mapEntry) {
      throw new SettingsError(`Unknown setting: ${dotKey}. Use /settings list to see available keys.`, 'SETTINGS_INVALID_KEY');
    }

    const schema = SETTINGS_SCHEMA.get(dotKey);
    const value = this.validateValue(dotKey, rawValue, schema);

    // Determine write target
    const writePath = this.resolveWriteTarget(dotKey);
    if (!writePath) {
      throw new SettingsError('No config file path available for writing.', 'SETTINGS_WRITE_FAILED');
    }

    // Check env var override
    const envVar = ENV_VAR_MAP.get(dotKey);
    if (envVar && process.env[envVar]) {
      console.warn(`Note: This key is overridden by env var ${envVar}. Saving to config. The env var takes precedence until unset.`);
    }

    // Read current file, apply change, write
    const fileConfig = await this.readConfigFile(writePath);
    this.applyValueToConfig(fileConfig, mapEntry.configPath, value);
    await this.persist(writePath, fileConfig);

    // Update in-memory
    this.applyValueToConfig(this.config, mapEntry.configPath, value);
    this.emitChange([dotKey]);
  }

  async reset(dotKey: string): Promise<void> {
    const mapEntry = SETTINGS_MAP.get(dotKey);
    if (!mapEntry) {
      throw new SettingsError(`Unknown setting: ${dotKey}. Use /settings list to see available keys.`, 'SETTINGS_INVALID_KEY');
    }

    const envVar = ENV_VAR_MAP.get(dotKey);
    if (envVar && process.env[envVar]) {
      throw new SettingsError(`Cannot reset: this value is set by env var ${envVar}. Unset the environment variable to use the default.`, 'SETTINGS_WRITE_FAILED');
    }

    const writePath = this.resolveWriteTarget(dotKey);
    if (!writePath) {
      throw new SettingsError('No config file path available for writing.', 'SETTINGS_WRITE_FAILED');
    }

    const fileConfig = await this.readConfigFile(writePath);
    this.removeValueFromConfig(fileConfig, mapEntry.configPath);
    await this.persist(writePath, fileConfig);

    // Reset in-memory to default
    const schema = SETTINGS_SCHEMA.get(dotKey);
    if (schema?.default !== undefined) {
      this.applyValueToConfig(this.config, mapEntry.configPath, schema.default);
    } else {
      this.removeValueFromConfig(this.config, mapEntry.configPath);
    }
    this.emitChange([dotKey]);
  }

  async resetAll(): Promise<void> {
    const writePath = this.projectConfigPath ?? this.globalConfigPath;
    if (!writePath) return;

    await this.persist(writePath, {});

    // Rebuild config from env vars (preserving env overrides)
    const rebuilt: Record<string, any> = {};
    for (const [dotKey, envVar] of ENV_VAR_MAP) {
      const val = process.env[envVar];
      if (val != null) {
        const entry = SETTINGS_MAP.get(dotKey);
        if (entry) this.applyValueToConfig(rebuilt, entry.configPath, val);
      }
    }
    this.config = rebuilt;
    this.emitChange(['*']);
  }

  // ── Events ─────────────────────────────────────────────────────────────

  onChange(callback: (changedKeys: string[]) => void): () => void {
    this.listeners.push(callback);
    return () => {
      this.listeners = this.listeners.filter(l => l !== callback);
    };
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private emitChange(changedKeys: string[]): void {
    for (const listener of this.listeners) {
      try { listener(changedKeys); } catch { /* non-fatal */ }
    }
  }

  private validateValue(dotKey: string, raw: unknown, schema?: SettingsSchemaEntry): unknown {
    if (!schema) return raw;

    switch (schema.type) {
      case 'number': {
        const num = typeof raw === 'number' ? raw : Number(raw);
        if (isNaN(num)) {
          throw new SettingsError(`${dotKey} must be a number. Got: "${raw}"`, 'SETTINGS_VALIDATION_FAILED');
        }
        if (schema.min !== undefined && num < schema.min) {
          throw new SettingsError(`${dotKey} must be >= ${schema.min}. Got: ${num}`, 'SETTINGS_VALIDATION_FAILED');
        }
        if (schema.max !== undefined && num > schema.max) {
          throw new SettingsError(`${dotKey} must be <= ${schema.max}. Got: ${num}`, 'SETTINGS_VALIDATION_FAILED');
        }
        return num;
      }
      case 'boolean': {
        if (typeof raw === 'boolean') return raw;
        const lower = String(raw).toLowerCase();
        if (lower === 'true' || lower === '1') return true;
        if (lower === 'false' || lower === '0') return false;
        throw new SettingsError(`${dotKey} must be true or false. Got: "${raw}"`, 'SETTINGS_VALIDATION_FAILED');
      }
      case 'enum': {
        if (!schema.enumValues?.includes(String(raw))) {
          throw new SettingsError(`${dotKey} must be one of: ${schema.enumValues?.join(', ')}. Got: "${raw}"`, 'SETTINGS_VALIDATION_FAILED');
        }
        return String(raw);
      }
      case 'array': {
        const list = Array.isArray(raw) ? raw : String(raw ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0);
        if (list.some((item) => typeof item !== 'string')) {
          throw new SettingsError(`${dotKey} must be an array of strings.`, 'SETTINGS_VALIDATION_FAILED');
        }
        if (list.some((item) => item.trim().length === 0)) {
          throw new SettingsError(`${dotKey} entries must be non-empty strings. Got: "${raw}"`, 'SETTINGS_VALIDATION_FAILED');
        }
        return list;
      }
      case 'string': {
        const str = String(raw ?? '');
        // URL validation for baseUrl/webhook fields
        if (dotKey.includes('baseUrl') || dotKey.includes('.webhook')) {
          try {
            const parsed = new URL(str);
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
              throw new SettingsError(`${dotKey} must be a valid URL starting with http:// or https://.`, 'SETTINGS_VALIDATION_FAILED');
            }
            if (parsed.username || parsed.password) {
              throw new SettingsError(`${dotKey} must not contain embedded credentials.`, 'SETTINGS_VALIDATION_FAILED');
            }
          } catch (e) {
            if (e instanceof SettingsError) throw e;
            throw new SettingsError(`${dotKey} must be a valid URL starting with http:// or https://.`, 'SETTINGS_VALIDATION_FAILED');
          }
        }
        // Hostname validation
        if (dotKey === 'smtp.host') {
          if (!/^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(str)) {
            throw new SettingsError(`${dotKey} must be a valid hostname.`, 'SETTINGS_VALIDATION_FAILED');
          }
        }
        return str;
      }
      default:
        return raw;
    }
  }

  private resolveConfigOrigin(configPath: string[]): string {
    if (this.hasPath(this.projectConfig, configPath)) return 'project config';
    if (this.hasPath(this.globalConfig, configPath)) return 'global config';
    return 'default';
  }

  private parseEnvValue(raw: string | undefined, schema?: SettingsSchemaEntry): unknown {
    const val = raw ?? '';
    if (!schema) return val;
    switch (schema.type) {
      case 'boolean':
        return val.toLowerCase() === 'true' || val === '1';
      case 'number':
        return Number(val);
      case 'array':
        return val.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
      default:
        return val;
    }
  }

  private resolveWriteTarget(dotKey: string): string | undefined {
    const envVar = ENV_VAR_MAP.get(dotKey);
    if (envVar && process.env[envVar]) {
      // Write to project config when env var overrides
      return this.projectConfigPath ?? this.globalConfigPath;
    }
    // Write to whichever config file currently owns the key
    const entry = SETTINGS_MAP.get(dotKey);
    if (!entry) return this.projectConfigPath ?? this.globalConfigPath;

    if (this.hasPath(this.projectConfig, entry.configPath) && this.projectConfigPath) {
      return this.projectConfigPath;
    }
    if (this.hasPath(this.globalConfig, entry.configPath) && this.globalConfigPath) {
      return this.globalConfigPath;
    }
    // New key — prefer project config if it exists
    return this.projectConfigPath ?? this.globalConfigPath;
  }

  private async readConfigFile(filePath: string): Promise<Record<string, any>> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(content);
    } catch {
      return {};
    }
  }

  private async persist(configPath: string, data: Record<string, any>): Promise<void> {
    const dir = path.dirname(configPath);
    await fs.mkdir(dir, { recursive: true });

    // Backup existing file
    try {
      await fs.rename(configPath, configPath + '.bak');
    } catch { /* no existing file to back up */ }

    // Atomic write via temp file
    const tmpPath = configPath + `.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
    await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), { mode: 0o600 });
    await fs.rename(tmpPath, configPath);
  }

  private getValueByPath(obj: Record<string, any>, pathParts: string[]): unknown {
    let current: any = obj;
    for (const part of pathParts) {
      if (current == null || typeof current !== 'object') return undefined;
      current = current[part];
    }
    return current;
  }

  private applyValueToConfig(obj: Record<string, any>, pathParts: string[], value: unknown): void {
    if (pathParts.length === 0) return;

    // Deep merge for models map
    if (pathParts[0] === 'models' && pathParts.length === 3) {
      if (!obj.models) obj.models = {};
      const provider = pathParts[1];
      if (!obj.models[provider]) obj.models[provider] = {};
      obj.models[provider][pathParts[2]] = value;
      return;
    }

    // Standard path
    let current: any = obj;
    for (let i = 0; i < pathParts.length - 1; i++) {
      if (current[pathParts[i]] == null || typeof current[pathParts[i]] !== 'object') {
        current[pathParts[i]] = {};
      }
      current = current[pathParts[i]];
    }
    current[pathParts[pathParts.length - 1]] = value;
  }

  private removeValueFromConfig(obj: Record<string, any>, pathParts: string[]): void {
    if (pathParts.length === 0) return;

    if (pathParts.length === 1) {
      delete obj[pathParts[0]];
      return;
    }

    let current: any = obj;
    for (let i = 0; i < pathParts.length - 1; i++) {
      if (current[pathParts[i]] == null) return;
      current = current[pathParts[i]];
    }
    delete current[pathParts[pathParts.length - 1]];
  }

  private hasPath(obj: Record<string, any>, pathParts: string[]): boolean {
    let current: any = obj;
    for (const part of pathParts) {
      if (current == null || typeof current !== 'object') return false;
      if (!(part in current)) return false;
      current = current[part];
    }
    return true;
  }

  private maskValue(value: string): string {
    if (!value || value.length < 8) return '******';
    return `${value.slice(0, 3)}...${value.slice(-4)}`;
  }
}
