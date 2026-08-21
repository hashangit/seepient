/**
 * Seepient Core — Config Utilities
 *
 * Config loading, merging, and environment overrides.
 * Chalk-free — suitable for all adapters (CLI, SDK, Server).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ── Constants ──────────────────────────────────────────────────────────

export function getGlobalConfigDir(): string {
  return path.join(os.homedir(), '.seepient');
}
export function getGlobalConfigFile(): string {
  return path.join(getGlobalConfigDir(), 'setting.json');
}
export function getLocalConfigFile(): string {
  return path.join(process.cwd(), '.seepient', 'setting.json');
}

// ── Types ──────────────────────────────────────────────────────────────

export interface AppConfig {
  hasExplicitModel?: boolean;
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
  return global ? getGlobalConfigFile() : getLocalConfigFile();
}

/**
 * Returns the config directory path for the given scope.
 */
export function getConfigDir(global?: boolean): string {
  return global ? getGlobalConfigDir() : path.join(process.cwd(), '.seepient');
}

/**
 * Returns both global and local config paths.
 */
export function getConfigPaths(): { global: string; local: string; globalDir: string } {
  return {
    global: getGlobalConfigFile(),
    local: getLocalConfigFile(),
    globalDir: getGlobalConfigDir(),
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
export function loadMergedConfig(customCwd?: string): AppConfig {
  const global = loadJsonConfig(getGlobalConfigFile());
  if (global.warning) {
    console.warn(`[Seepient] ${global.warning}`);
  }
  const cwd = customCwd || process.env.SEEPIENT_CWD || process.cwd();
  const local = loadJsonConfig(path.join(cwd, '.seepient', 'setting.json'));
  if (local.warning) {
    console.warn(`[Seepient] ${local.warning}`);
  }
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

  return config;
}

// ── Save ───────────────────────────────────────────────────────────────

/**
 * Save config to disk. If a local config exists, saves there; otherwise global.
 */
export function saveConfig(config: AppConfig): void {
  const targetFile = fs.existsSync(getLocalConfigFile())
    ? getLocalConfigFile()
    : getGlobalConfigFile();

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
