/**
 * Seepient Core — Provider Configuration Types & Mutation
 *
 * Types, singleton management, config mutation functions, and file-based resolution.
 * Extracted from provider-resolver.ts for single-responsibility.
 */

import { createProvider, type ProviderConfig } from "../providers/factory.js";
import type { LLMProvider } from "../providers/types.js";
import type { MultiProviderConfig, ProviderType } from "./types.js";
import {
  DEFAULT_MODELS,
  PROVIDER_ENV_KEYS,
  resolveApiKey,
  resolveBaseUrl,
  resolveDefaultType,
  resolveDefaultModel,
} from "./provider-env.js";
import {
  type AppConfig,
  applyEnvOverrides,
  loadMergedConfig,
  resolveActiveProviderType,
} from "./config.js";

// Re-export AppConfig so the provider-resolver → core/index chain works
export type { AppConfig };

// ── Types ────────────────────────────────────────────────────────────

/**
 * Resolved provider configuration with all required fields.
 * This is what consumers receive after resolution.
 */
export interface ResolvedProviderConfig {
  type: ProviderType;
  apiKey: string;
  model: string;
  baseUrl?: string;
  timeout?: number;
}

/**
 * Module-level singleton that holds multi-provider configuration.
 */
let providerConfig: MultiProviderConfig | null = null;

// ── Public API ───────────────────────────────────────────────────────

/**
 * Creates a single provider configuration object.
 * Useful for building `MultiProviderConfig` declaratively.
 */
export function provider(
  type: ProviderType,
  apiKey: string,
  options?: { model?: string; baseUrl?: string; timeout?: number },
): {
  type: ProviderType;
  apiKey: string;
  model?: string;
  baseUrl?: string;
  timeout?: number;
} {
  return {
    type,
    apiKey,
    ...options,
  };
}

/**
 * Stores multi-provider configuration globally.
 * Can be called once at application startup.
 */
export function configureProviders(config: MultiProviderConfig): void {
  providerConfig = config;
}

/**
 * Returns the raw configuration for a given provider type.
 * Falls back to environment variables when no explicit config is set.
 *
 * @param type - Provider type. If omitted, uses the default provider.
 * @returns Resolved provider configuration with apiKey, model, and optional baseUrl.
 * @throws Error if the provider is not configured and no env var is available.
 */
export function getProviderConfig(
  type?: ProviderType,
): { apiKey: string; model: string; baseUrl?: string; type: ProviderType } {
  const resolvedType = type ?? getDefaultProviderType();

  // 1. Check explicit config first
  if (providerConfig) {
    const entry = providerConfig[resolvedType];
    if (entry && "apiKey" in entry) {
      const cfg = entry as { apiKey: string; model?: string; baseUrl?: string };
      return {
        type: resolvedType,
        apiKey: cfg.apiKey,
        model: cfg.model ?? resolveDefaultModel(resolvedType),
        baseUrl: cfg.baseUrl,
      };
    }
  }

  // 2. Fall back to environment variables
  const apiKey = resolveApiKey(resolvedType);
  if (!apiKey) {
    const envHint = PROVIDER_ENV_KEYS[resolvedType].apiKey;
    throw new Error(
      `No provider is configured. Pass \`provider\` to generateText/createAgent/streamText, ` +
        `call \`configureProviders(loadProviderConfig())\` at startup, or set the ${envHint} env var.`,
    );
  }

  return {
    type: resolvedType,
    apiKey,
    model: resolveDefaultModel(resolvedType),
    baseUrl: resolveBaseUrl(resolvedType),
  };
}

/**
 * Resolves which provider type is the default.
 * Checks explicit config, then LLM_PROVIDER env var, then falls back to "openai".
 */
export function getDefaultProviderType(): ProviderType {
  if (providerConfig?.default) {
    return providerConfig.default;
  }
  return resolveDefaultType();
}

/**
 * Returns the default configured provider type (alias for getDefaultProviderType).
 */
export function getDefaultProvider(): ProviderType {
  return getDefaultProviderType();
}

/**
 * Creates and returns an LLMProvider instance using the existing factory.
 * If type is omitted, uses the default provider.
 *
 * @param type - Provider type. If omitted, uses the default provider.
 * @param modelOverride - When set, overrides the resolved model before creating the provider.
 * @returns The initialized LLMProvider and the resolved model name.
 */
export async function getProvider(
  type?: ProviderType,
  modelOverride?: string,
): Promise<{ provider: LLMProvider; model: string }> {
  const config = getProviderConfig(type);

  const factoryConfig: ProviderConfig = {
    type: config.type,
    apiKey: config.apiKey,
    model: modelOverride ?? config.model,
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
  };

  const llmProvider = await createProvider(factoryConfig);

  return {
    provider: llmProvider,
    model: modelOverride ?? config.model,
  };
}

// ── CLI-specific functions ───────────────────────────────────────────

/**
 * Resolves provider configuration from legacy AppConfig (CLI format).
 * This handles both old-style top-level config and new models map format.
 */
export function resolveProviderConfigFromApp(
  config: AppConfig,
  providerType: ProviderType,
): ProviderConfig | null {
  const modelConfig = config.models?.[providerType];
  if (!modelConfig) return null;

  const apiKey = ("apiKey" in modelConfig) ? modelConfig.apiKey : config.apiKey;
  if (!apiKey) return null;

  const model = "model" in modelConfig ? modelConfig.model : config.model || DEFAULT_MODELS[providerType];
  const baseUrl = "baseUrl" in modelConfig ? modelConfig.baseUrl : config.baseUrl;

  return { type: providerType, apiKey, model, baseUrl };
}

// ── CLI-config bridge ────────────────────────────────────────────────

/**
 * Load CLI-style config (~/.seepient/setting.json + .seepient/setting.json + env
 * overrides) and translate it to a MultiProviderConfig suitable for
 * `configureProviders()`.
 *
 * When `app` is provided, uses that config directly (callers that have already
 * loaded and mutated their AppConfig should pass it here). Otherwise reads
 * fresh from disk via `loadMergedConfig()` + `applyEnvOverrides()`.
 *
 * @returns MultiProviderConfig if any provider has a configured apiKey, null otherwise.
 *          Callers should check for null before passing to configureProviders().
 */
export function loadProviderConfig(app?: AppConfig, cliProvider?: string): MultiProviderConfig | null {
  const appConfig = app ?? applyEnvOverrides(loadMergedConfig());
  const multi = {} as MultiProviderConfig;
  const types: ProviderType[] = [
    "openai",
    "anthropic",
    "glm",
    "openai-compatible",
  ];
  for (const t of types) {
    const entry = appConfig.models?.[t];
    if (entry && "apiKey" in entry && entry.apiKey) {
      (multi as unknown as Record<string, unknown>)[t] = entry;
    }
  }

  const collected = Object.keys(multi) as ProviderType[];
  if (collected.length === 0) return null;

  // Derive `default`: CLI flag → config.provider → resolveActiveProviderType(),
  // but only if that provider was actually collected above. Otherwise fall back
  // to the first collected entry so `default` always points at a real provider.
  const candidate =
    (cliProvider as ProviderType | undefined) ??
    (appConfig.provider as ProviderType | undefined) ??
    resolveActiveProviderType(appConfig);
  multi.default = collected.includes(candidate) ? candidate : collected[0];

  return multi;
}

// ── Config-file resolution ───────────────────────────────────────────

/**
 * Resolves provider configuration from a config file object.
 * Supports both legacy AppConfig format and new MultiProviderConfig format.
 */
export function resolveFromConfigFile(
  config: any,
  type?: ProviderType,
): ResolvedProviderConfig | null {
  // First, try to treat it as MultiProviderConfig (new format)
  if (config.models || config.default) {
    const multiConfig = config as MultiProviderConfig;
    const resolvedType = type ?? multiConfig.default ?? "openai";
    const entry = multiConfig[resolvedType];

    if (entry && "apiKey" in entry) {
      return {
        type: resolvedType,
        apiKey: entry.apiKey,
        model: entry.model ?? DEFAULT_MODELS[resolvedType],
        baseUrl: "baseUrl" in entry ? entry.baseUrl : undefined,
      };
    }
  }

  // Fall back to legacy AppConfig format
  if (config.apiKey || config.models) {
    const appConfig = migrateLegacyConfig(config);
    return resolveFromConfigFile(appConfig, type);
  }

  return null;
}

/**
 * Migrates legacy top-level config to the new models map format.
 */
export function migrateLegacyConfig(config: any): MultiProviderConfig {
  const result: any = {};

  // If config already has models map, it's not legacy
  if (config.models) {
    return config as MultiProviderConfig;
  }

  // Migrate top-level provider config
  const providerType = config.provider || "openai";
  if (config.apiKey) {
    result[providerType] = {
      apiKey: config.apiKey,
      ...(config.model ? { model: config.model } : {}),
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    };
  }

  result.default = providerType;
  return result as MultiProviderConfig;
}

// ── Provider mutation functions ──────────────────────────────────────

/**
 * Adds or updates a provider configuration.
 * Modifies the global providerConfig singleton.
 */
export function addProvider(
  type: ProviderType,
  config: { apiKey: string; model?: string; baseUrl?: string },
): void {
  if (!providerConfig) {
    providerConfig = { default: type } as MultiProviderConfig;
  }
  // For openai-compatible, baseUrl is required
  if (type === "openai-compatible" && !config.baseUrl) {
    throw new Error('Provider "openai-compatible" requires a baseUrl.');
  }
  (providerConfig as any)[type] = config;
}

/**
 * Updates an existing provider configuration.
 * Only updates the specified fields, preserving others.
 */
export function updateProviderConfig(
  type: ProviderType,
  updates: Partial<{ model: string; baseUrl: string }>,
): void {
  if (!providerConfig?.[type]) {
    throw new Error(`Provider "${type}" is not configured. Use addProvider() first.`);
  }

  const existing = providerConfig[type] as any;
  providerConfig[type] = {
    ...existing,
    ...updates,
  };
}

/**
 * Removes a provider configuration.
 */
export function removeProvider(type: ProviderType): void {
  if (!providerConfig) {
    return;
  }

  delete providerConfig[type];

  // If we removed the default, switch to another available provider
  if (providerConfig.default === type) {
    const remaining = Object.keys(providerConfig).filter(k => k !== "default") as ProviderType[];
    if (remaining.length > 0) {
      providerConfig.default = remaining[0];
    }
  }
}

/**
 * Saves the current provider configuration to a file.
 */
export async function saveConfig(configPath?: string): Promise<void> {
  if (!providerConfig) {
    throw new Error("No provider configuration to save. Call configureProviders() first.");
  }

  const fs = await import("fs");
  const path = await import("path");
  const os = await import("os");

  const targetPath = configPath ?? path.join(os.homedir(), ".seepientrc.json");
  const dir = path.dirname(targetPath);

  // Ensure directory exists
  await fs.promises.mkdir(dir, { recursive: true });

  // Write config file
  await fs.promises.writeFile(
    targetPath,
    JSON.stringify(providerConfig, null, 2),
    "utf-8",
  );
}
