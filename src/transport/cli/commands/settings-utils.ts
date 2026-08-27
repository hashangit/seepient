/**
 * Seepient CLI — Settings Display Utilities
 *
 * Pure formatting functions for settings display.
 * Render functions produce bordered ASCII boxes for the wizard TUI.
 */

import {
  ENV_VAR_MAP,
  SETTINGS_MAP,
  SETTINGS_SCHEMA,
  isSecretField,
  isRestartRequired,
  SettingsCategory,
} from '../../../foundations/settings-schema.js';
import type { SettingsManager } from '../../../domain/settings/settings-manager.js';

// ── Value formatting ──────────────────────────────────────────────────────

export function formatSettingValue(value: unknown, secret: boolean): string {
  if (value === undefined || value === null) return '(not set)';
  if (secret) return maskValue(String(value));
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

export function maskValue(value: string): string {
  if (!value || value.length < 8) return '******';
  return `${value.slice(0, 3)}...${value.slice(-4)}`;
}

// ── Origin resolution ─────────────────────────────────────────────────────

export function getOriginLabel(
  dotKey: string,
  projectConfig?: Record<string, any>,
  globalConfig?: Record<string, any>,
): string {
  const envVar = ENV_VAR_MAP.get(dotKey);
  if (envVar && process.env[envVar]) return `env: ${envVar}`;

  const entry = SETTINGS_MAP.get(dotKey);
  if (!entry) return 'default';

  if (projectConfig && hasPath(projectConfig, entry.configPath)) {
    return 'project config';
  }
  if (globalConfig && hasPath(globalConfig, entry.configPath)) {
    return 'global config';
  }
  return 'default';
}

// ── Table formatting (for /settings list) ─────────────────────────────────

export interface SettingRow {
  dotKey: string;
  value: string;
  origin: string;
  category: string;
  restartRequired: boolean;
}

export function formatSettingTable(settings: SettingRow[]): string {
  if (settings.length === 0) return '  No settings found.';

  const col1 = 24;
  const col2 = 20;
  const lines: string[] = [];

  lines.push(`  ${padTo('Setting', col1)} ${padTo('Value', col2)} Origin`);
  lines.push(`  ${'─'.repeat(col1)} ${'─'.repeat(col2)} ${'─'.repeat(20)}`);

  for (const s of settings) {
    const originSuffix = s.restartRequired ? '  [restart]' : '';
    lines.push(`  ${padTo(s.dotKey, col1)} ${padTo(s.value, col2)} ${s.origin}${originSuffix}`);
  }

  return lines.join('\n');
}

// ── Wizard renderers ──────────────────────────────────────────────────────

/**
 * Render the bordered header box for Level 1 (category menu).
 * Shows current provider, model, permissions, and auto-confirm.
 */
export function renderWizardHeader(manager: SettingsManager): string {
  const width = Math.max(40, Math.min(50, (process.stdout.columns ?? 80) - 2));
  const halfWidth = Math.floor((width - 4) / 2);

  const provider = manager.get('provider').value ?? 'not configured';
  const consentMode = manager.get('permissions.consentMode')?.value ?? 'edit-enabled';
  const autoConfirm = manager.get('agent.autoConfirm').value ?? false;

  // Resolve current model from active provider
  let model = 'not configured';
  const providerModelMap: Record<string, string> = {
    'openai': 'providers.openai.model',
    'anthropic': 'providers.anthropic.model',
    'glm': 'providers.glm.model',
    'openai-compatible': 'providers.openai-compat.model',
  };
  const modelKey = providerModelMap[String(provider)];
  if (modelKey) {
    const modelResult = manager.get(modelKey);
    if (modelResult.value != null) model = String(modelResult.value);
  }

  const left1 = `Provider: ${provider}`;
  const right1 = `Model: ${model}`;
  const left2 = `Mode: ${consentMode}`;
  const right2 = `Auto-confirm: ${autoConfirm ? 'on' : 'off'}`;

  const lines: string[] = [];
  lines.push(`┌${'─'.repeat(width - 2)}┐`);
  lines.push(`│${padTo('  Current Settings', width - 2)}│`);
  lines.push(`│${' '.repeat(width - 2)}│`);
  lines.push(`│  ${padTo(left1, halfWidth)}  ${padTo(right1, halfWidth)}│`);
  lines.push(`│  ${padTo(left2, halfWidth)}  ${padTo(right2, halfWidth)}│`);
  lines.push(`│${' '.repeat(width - 2)}│`);
  lines.push(`│${padTo('  ? What would you like to change?', width - 2)}│`);
  lines.push(`└${'─'.repeat(width - 2)}┘`);

  return lines.join('\n');
}

/**
 * Render the aligned settings list for Level 2 (category drilldown).
 * 3-column layout: label, value, origin.
 */
export function renderSettingsList(keys: string[], manager: SettingsManager): string {
  if (keys.length === 0) return '  (none configured)';

  const col1 = 28;
  const col2 = 18;
  const lines: string[] = [];

  for (const key of keys) {
    const entry = SETTINGS_MAP.get(key);
    const schema = SETTINGS_SCHEMA.get(key);
    const result = manager.get(key);
    const label = entry?.label ?? key;
    const value = formatSettingValue(result.value, result.masked);
    const origin = result.origin;
    const restartTag = schema?.restartRequired ? '  [restart]' : '';
    lines.push(`  ${padTo(label, col1)} ${padTo(value, col2)} ${chalk_dim(origin)}${restartTag}`);
  }

  return lines.join('\n');
}

/**
 * Render the bordered mini-form for Level 3 (setting edit).
 * Shows setting name, current value, source, and type.
 */
export function renderSettingForm(dotKey: string, manager: SettingsManager): string {
  const width = Math.max(36, Math.min(42, (process.stdout.columns ?? 80) - 2));

  const entry = SETTINGS_MAP.get(dotKey);
  const schema = SETTINGS_SCHEMA.get(dotKey);
  const result = manager.get(dotKey);
  const label = entry?.label ?? dotKey;

  const current = formatSettingValue(result.value, result.masked);
  const origin = result.origin;
  const type = schema?.type ?? 'string';
  const restartTag = schema?.restartRequired ? '  [restart required]' : '';

  const lines: string[] = [];
  lines.push(`┌${'─'.repeat(width - 2)}┐`);
  lines.push(`│${padTo(`  ${label}${restartTag}`, width - 2)}│`);
  lines.push(`│${' '.repeat(width - 2)}│`);
  lines.push(`│${padTo(`  Current:  ${current}`, width - 2)}│`);
  lines.push(`│${padTo(`  Source:   ${origin}`, width - 2)}│`);
  lines.push(`│${padTo(`  Type:     ${type}`, width - 2)}│`);
  lines.push(`└${'─'.repeat(width - 2)}┘`);

  return lines.join('\n');
}

/**
 * Render the category status label for the Level 1 menu.
 */
export function renderCategoryStatus(categoryKey: SettingsCategory, manager: SettingsManager): string {
  const keys: string[] = [];
  for (const entry of SETTINGS_MAP.values()) {
    if (entry.category === categoryKey) keys.push(entry.dotKey);
  }

  if (keys.length === 0) return '(reserved)';

  const configured = keys.filter(k => {
    const v = manager.get(k).value;
    return v !== undefined && v !== null && v !== '';
  }).length;

  if (configured === 0) return '[not set]';
  if (configured === keys.length) return '[configured]';
  return '[partially configured]';
}

// ── Helpers ───────────────────────────────────────────────────────────────

function padTo(str: string, len: number): string {
  if (str.length >= len) return str.slice(0, len - 1) + ' ';
  return str + ' '.repeat(len - str.length);
}

function hasPath(obj: Record<string, any>, pathParts: string[]): boolean {
  let current: any = obj;
  for (const part of pathParts) {
    if (current == null || typeof current !== 'object') return false;
    if (!(part in current)) return false;
    current = current[part];
  }
  return true;
}

function chalk_dim(str: string): string {
  return `\x1b[2m${str}\x1b[0m`;
}
