/**
 * Seepient Core — Config Utilities
 *
 * Config loading, merging, and environment overrides.
 * Chalk-free — suitable for all adapters (CLI, SDK, Server).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ProviderType } from './contracts/llm.js';
import { DEFAULT_MODELS } from './models-catalog.js';

// ── Constants ──────────────────────────────────────────────────────────

const GLOBAL_CONFIG_DIR = path.join(os.homedir(), '.seepient');
const GLOBAL_CONFIG_FILE = path.join(GLOBAL_CONFIG_DIR, 'setting.json');
const LOCAL_CONFIG_FILE = path.join(process.cwd(), '.seepient', 'setting.json');

// ── Types ──────────────────────────────────────────────────────────────

export interface AppConfig {
  provider?: ProviderType;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  hasExplicitModel?: boolean;
  models?: {
    'openai-compatible'?: { apiKey: string; baseUrl: string; model: string; };
    openai?: { apiKey: string; model: string; };
    anthropic?: { apiKey: string; model: string; };
    glm?: { apiKey: string; model: string; };
  };
  // Image gen (always OpenAI)
  imageApiKey?: string;
  imageBaseUrl?: string;
  imageModel?: string;
  imageSize?: string;
  imageQuality?: string;
  imageStyle?: string;
  imageN?: number;
  // Existing tools (unchanged)
  smtpHost?: string;
  smtpPort?: string;
  smtpUser?: string;
  smtpPass?: string;
  smtpFrom?: string;
  tavilyApiKey?: string;
  autoConfirm?: boolean;
  permissionLevel?: "strict" | "moderate" | "permissive";
  feishuWebhook?: string;
  feishuKeyword?: string;
  dingtalkWebhook?: string;
  dingtalkKeyword?: string;
  wecomWebhook?: string;
  wecomKeyword?: string;
}

// ── Config path helpers ────────────────────────────────────────────────

/**
 * Returns the config file path for the given scope.
 */
export function getConfigPath(global?: boolean): string {
  return global ? GLOBAL_CONFIG_FILE : LOCAL_CONFIG_FILE;
}

/**
 * Returns the config directory path for the given scope.
 */
export function getConfigDir(global?: boolean): string {
  return global ? GLOBAL_CONFIG_DIR : path.join(process.cwd(), '.seepient');
}

/**
 * Returns both global and local config paths.
 */
export function getConfigPaths(): { global: string; local: string; globalDir: string } {
  return {
    global: GLOBAL_CONFIG_FILE,
    local: LOCAL_CONFIG_FILE,
    globalDir: GLOBAL_CONFIG_DIR,
  };
}

// ── JSON loading ───────────────────────────────────────────────────────

/**
 * Load and parse a JSON config file.
 * Returns `{ config, warning }` — warning is set if parsing failed.
 */
export function loadJsonConfig(filePath: string): { config: AppConfig; warning?: string } {
  if (fs.existsSync(filePath)) {
    try {
      return { config: JSON.parse(fs.readFileSync(filePath, 'utf-8')) };
    } catch (e) {
      return {
        config: {},
        warning: `Warning: Failed to parse config file at ${filePath}`,
      };
    }
  }
  return { config: {} };
}

// ── Merge & overlay ────────────────────────────────────────────────────

/**
 * Load global and local configs and merge them.
 * Priority: local > global.
 */
export function loadMergedConfig(): AppConfig {
  const global = loadJsonConfig(GLOBAL_CONFIG_FILE);
  const local = loadJsonConfig(LOCAL_CONFIG_FILE);
  return { ...global.config, ...local.config };
}

/**
 * Apply environment variable overrides to the merged config.
 * Env vars take priority over JSON config for tool settings.
 * Also injects provider API keys from env vars into the models map.
 */
export function applyEnvOverrides(config: AppConfig): AppConfig {
  // Tool settings
  if (process.env.SMTP_HOST) config.smtpHost = process.env.SMTP_HOST;
  if (process.env.SMTP_PORT) config.smtpPort = process.env.SMTP_PORT;
  if (process.env.SMTP_USER) config.smtpUser = process.env.SMTP_USER;
  if (process.env.SMTP_PASS) config.smtpPass = process.env.SMTP_PASS;
  if (process.env.TAVILY_API_KEY) config.tavilyApiKey = process.env.TAVILY_API_KEY;
  if (process.env.FEISHU_WEBHOOK) config.feishuWebhook = process.env.FEISHU_WEBHOOK;
  if (process.env.FEISHU_KEYWORD) config.feishuKeyword = process.env.FEISHU_KEYWORD;
  if (process.env.DINGTALK_WEBHOOK) config.dingtalkWebhook = process.env.DINGTALK_WEBHOOK;
  if (process.env.DINGTALK_KEYWORD) config.dingtalkKeyword = process.env.DINGTALK_KEYWORD;
  if (process.env.WECOM_WEBHOOK) config.wecomWebhook = process.env.WECOM_WEBHOOK;
  if (process.env.WECOM_KEYWORD) config.wecomKeyword = process.env.WECOM_KEYWORD;

  // Permission level
  if (process.env.SEEPIENT_PERMISSION) {
    const val = process.env.SEEPIENT_PERMISSION;
    if (val === "strict" || val === "moderate" || val === "permissive") {
      config.permissionLevel = val;
    }
  }

  // Provider API keys — inject into models map from env vars
  if (!config.models) config.models = {};

  if (process.env.OPENAI_API_KEY) {
    config.models.openai = {
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.OPENAI_MODEL || config.models.openai?.model || DEFAULT_MODELS.openai,
    };
  }
  if (process.env.OPENAI_COMPAT_API_KEY) {
    config.models['openai-compatible'] = {
      apiKey: process.env.OPENAI_COMPAT_API_KEY,
      baseUrl: process.env.OPENAI_COMPAT_BASE_URL || process.env.OPENAI_BASE_URL || config.models['openai-compatible']?.baseUrl || 'https://api.openai.com/v1',
      model: process.env.OPENAI_COMPAT_MODEL || process.env.LLM_MODEL || process.env.SEEPIENT_MODEL || config.models['openai-compatible']?.model || DEFAULT_MODELS['openai-compatible'],
    };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    config.models.anthropic = {
      apiKey: process.env.ANTHROPIC_API_KEY,
      model: process.env.ANTHROPIC_MODEL || config.models.anthropic?.model || DEFAULT_MODELS.anthropic,
    };
  }
  if (process.env.GLM_API_KEY) {
    config.models.glm = {
      apiKey: process.env.GLM_API_KEY,
      model: process.env.GLM_MODEL || config.models.glm?.model || DEFAULT_MODELS.glm,
    };
  }

  return config;
}

/**
 * Auto-migrate legacy config format (top-level apiKey/baseUrl/model) to the
 * models map format used by the current architecture.
 */
export function migrateLegacyFormat(
  config: AppConfig,
  options?: { model?: string },
): AppConfig {
  if (!config.models && (config.apiKey || process.env.OPENAI_API_KEY)) {
    config.models = {
      openai: {
        apiKey: process.env.OPENAI_API_KEY || config.apiKey || '',
        model: options?.model || process.env.OPENAI_MODEL || config.model || DEFAULT_MODELS.openai,
      },
    };
    if (!config.provider) config.provider = 'openai';
  }
  return config;
}

/**
 * Resolve the active provider type from CLI flags, env vars, and config.
 * Checks LLM_PROVIDER env var as a standard alias for SEEPIENT_PROVIDER.
 */
export function resolveActiveProviderType(
  config: AppConfig,
  options?: { provider?: string },
): ProviderType {
  return (
    (options?.provider as ProviderType) ||
    (process.env.LLM_PROVIDER as ProviderType) ||
    (process.env.SEEPIENT_PROVIDER as ProviderType) ||
    config.provider ||
    'openai'
  );
}

// ── Save ───────────────────────────────────────────────────────────────

/**
 * Save config to disk. If a local config exists, saves there; otherwise global.
 */
export function saveConfig(config: AppConfig): void {
  const targetFile = fs.existsSync(path.join(process.cwd(), '.seepient', 'setting.json'))
    ? LOCAL_CONFIG_FILE
    : GLOBAL_CONFIG_FILE;

  writeConfigToPath(config, targetFile);
}

/**
 * Save config to a specific path.
 * Throws on failure — callers handle error display.
 */
export function writeConfigToPath(config: AppConfig, targetFile: string): void {
  const dir = path.dirname(targetFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(targetFile, JSON.stringify(config, null, 2), { mode: 0o600 });
}

// ── Utility ────────────────────────────────────────────────────────────

/**
 * Mask a secret string for display, showing only first 3 and last 4 chars.
 */
export function maskSecret(secret?: string): string {
  if (!secret || secret.length < 8) return '******';
  return `${secret.slice(0, 3)}...${secret.slice(-4)}`;
}
