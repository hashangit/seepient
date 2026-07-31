/**
 * Seepient Core — Unified Provider Resolver
 *
 * Re-export hub. All logic has been split into:
 *   - provider-env.ts    — env var helpers, defaults, resolveFromEnv(), resolveGLMModel()
 *   - provider-config.ts — types, singleton, mutation, getProvider(), resolveFromConfigFile()
 *
 * This file preserves all existing import paths. No consumer changes needed.
 */

// ── From provider-env.ts ─────────────────────────────────────────────

export {
  DEFAULT_MODELS,
  PROVIDER_ENV_KEYS,
  resolveFromEnv,
  resolveGLMModel,
} from "./provider-env.js";

// ── From provider-config.ts ──────────────────────────────────────────

export type { ResolvedProviderConfig, AppConfig } from "./provider-config.js";

export {
  provider,
  configureProviders,
  loadProviderConfig,
  getProviderConfig,
  getDefaultProviderType,
  getDefaultProvider,
  getProvider,
  resolveProviderConfigFromApp,
  createProviderFromApp,
  resolveFromConfigFile,
  migrateLegacyConfig,
  addProvider,
  updateProviderConfig,
  removeProvider,
  saveConfig,
} from "./provider-config.js";
