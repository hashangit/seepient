/**
 * Seepient CLI — Config Loader
 *
 * Re-exports core config utilities and adds CLI-specific chalk output.
 */

import chalk from 'chalk';
import type { AppConfig } from '../../core/config.js';
import {
  loadJsonConfig as coreLoadJsonConfig,
  loadMergedConfig as coreLoadMergedConfig,
  applyEnvOverrides,
  getConfigPath,
  getConfigDir,
  getConfigPaths,
  migrateLegacyFormat,
  resolveActiveProviderType,
  saveConfig as coreSaveConfig,
  writeConfigToPath as coreWriteConfigToPath,
  maskSecret,
} from '../../core/config.js';

// ── Re-exports (unchanged API for CLI consumers) ───────────────────────

export {
  AppConfig,
  applyEnvOverrides,
  getConfigPath,
  getConfigDir,
  getConfigPaths,
  migrateLegacyFormat,
  resolveActiveProviderType,
  maskSecret,
};

// ── CLI wrappers with chalk output ─────────────────────────────────────

/**
 * Load and parse a JSON config file, returning {} on failure.
 * Logs parse warnings to console with chalk.
 */
export function loadJsonConfig(filePath: string): AppConfig {
  const { config, warning } = coreLoadJsonConfig(filePath);
  if (warning) {
    console.error(chalk.yellow(warning));
  }
  return config;
}

/**
 * Load global and local configs and merge them.
 * Priority: local > global.
 */
export function loadMergedConfig(): AppConfig {
  // Use the core version directly — it calls coreLoadJsonConfig internally
  // and doesn't produce warnings the CLI needs to display at this level.
  return coreLoadMergedConfig();
}

/**
 * Save config to disk. If a local config exists, saves there; otherwise global.
 */
export function saveConfig(config: AppConfig): void {
  coreSaveConfig(config);
}

/**
 * Save config to a specific path.
 * Logs errors to console with chalk.
 */
export function writeConfigToPath(config: AppConfig, targetFile: string): void {
  try {
    coreWriteConfigToPath(config, targetFile);
  } catch (e: any) {
    console.error(chalk.red(`Failed to save config: ${e.message}`));
  }
}
