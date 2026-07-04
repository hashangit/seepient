/**
 * Seepient SDK — Settings Facade
 *
 * Wraps SettingsManager for SDK consumers.
 * Import via `import { settings } from 'seepient'`.
 */

import {
  SettingsManager,
  SettingsError,
  SettingValue,
  SettingEntry,
} from '../../core/settings-manager.js';
import { SettingsCategory } from '../../core/settings-schema.js';
import {
  loadMergedConfig,
  loadJsonConfig,
  getConfigPaths,
  applyEnvOverrides,
  AppConfig,
} from '../../core/config.js';

// ── Singleton ─────────────────────────────────────────────────────────────

let manager: SettingsManager | null = null;

function getManager(): SettingsManager {
  if (!manager) {
    const config = applyEnvOverrides(loadMergedConfig());
    const paths = getConfigPaths();
    const projectResult = loadJsonConfig(paths.local);
    const globalResult = loadJsonConfig(paths.global);

    manager = new SettingsManager({
      config,
      projectConfigPath: paths.local,
      globalConfigPath: paths.global,
      projectConfig: projectResult.config as Record<string, any>,
      globalConfig: globalResult.config as Record<string, any>,
    });
  }
  return manager;
}

// ── Public API ────────────────────────────────────────────────────────────

export const settings = {
  get(dotKey: string): SettingValue {
    return getManager().get(dotKey);
  },

  async set(dotKey: string, value: string): Promise<void> {
    return getManager().set(dotKey, value);
  },

  async apply(updates: Record<string, string>): Promise<void> {
    const m = getManager();
    for (const [key, value] of Object.entries(updates)) {
      await m.set(key, value);
    }
  },

  list(): SettingEntry[] {
    return getManager().list();
  },

  listByCategory(): Record<string, SettingEntry[]> {
    return getManager().listByCategory();
  },

  onChange(callback: (changedKeys: string[]) => void): () => void {
    return getManager().onChange(callback);
  },

  async reset(dotKey: string): Promise<void> {
    return getManager().reset(dotKey);
  },

  async resetAll(): Promise<void> {
    return getManager().resetAll();
  },
};

export { SettingsError };
