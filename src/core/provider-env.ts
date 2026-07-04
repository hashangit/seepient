/**
 * Seepient Core — Provider Environment Resolution
 *
 * Environment variable helpers, default models, and env-based resolution.
 * Extracted from provider-resolver.ts for single-responsibility.
 */

import { GLM_MODEL_MAP } from "../providers/factory.js";
import { DEFAULT_MODELS } from "../models-catalog.js";
import type { MultiProviderConfig, ProviderType } from "./types.js";

// ── Default models per provider ──────────────────────────────────────

export { DEFAULT_MODELS };

// ── Env var keys per provider ────────────────────────────────────────

export const PROVIDER_ENV_KEYS: Record<
  ProviderType,
  { apiKey: string; baseUrl?: string }
> = {
  openai: { apiKey: "OPENAI_API_KEY" },
  anthropic: { apiKey: "ANTHROPIC_API_KEY" },
  glm: { apiKey: "GLM_API_KEY" },
  "openai-compatible": {
    apiKey: "OPENAI_COMPAT_API_KEY",
    baseUrl: "OPENAI_COMPAT_BASE_URL",
  },
};

// ── Internal helpers ─────────────────────────────────────────────────

export function env(name: string): string | undefined {
  return process.env[name];
}

export function resolveApiKey(type: ProviderType): string | undefined {
  // Per-provider env var takes priority
  const envKeys = PROVIDER_ENV_KEYS[type];
  if (envKeys.apiKey) {
    const key = env(envKeys.apiKey);
    if (key) return key;
  }
  // Backward compat: check deprecated env vars
  if (type === "openai-compatible") {
    const legacy = env("SEEPIENT_API_KEY");
    if (legacy) {
      console.warn("[seepient] SEEPIENT_API_KEY is deprecated. Use OPENAI_COMPAT_API_KEY instead.");
      return legacy;
    }
  }
  return undefined;
}

export function resolveBaseUrl(type: ProviderType): string | undefined {
  const envKeys = PROVIDER_ENV_KEYS[type];
  if (envKeys.baseUrl) {
    const url = env(envKeys.baseUrl);
    if (url) return url;
  }
  // Backward compat: check deprecated env var for openai-compatible
  if (type === "openai-compatible") {
    const legacy = env("OPENAI_BASE_URL");
    if (legacy) {
      console.warn("[seepient] OPENAI_BASE_URL is deprecated. Use OPENAI_COMPAT_BASE_URL instead.");
      return legacy;
    }
  }
  return undefined;
}

export function resolveDefaultType(): ProviderType {
  const fromEnv = env("LLM_PROVIDER") ?? env("SEEPIENT_PROVIDER");
  if (
    fromEnv &&
    (fromEnv === "openai" ||
      fromEnv === "anthropic" ||
      fromEnv === "glm" ||
      fromEnv === "openai-compatible")
  ) {
    return fromEnv;
  }
  return "openai";
}

export function resolveDefaultModel(type: ProviderType): string {
  return env("LLM_MODEL") ?? env("SEEPIENT_MODEL") ?? DEFAULT_MODELS[type];
}

// ── GLM model alias resolution ───────────────────────────────────────

/**
 * Resolve a GLM model alias or model name to the actual model identifier.
 *
 * Looks up the model in the GLM_MODEL_MAP (e.g. "haiku" -> "glm-4.5-air",
 * "sonnet" -> "glm-4.7", "opus" -> "glm-5.1"). If the model is not found in
 * the map, it is returned unchanged.
 *
 * @param model - Model name or alias to resolve.
 * @returns The resolved model identifier.
 */
export function resolveGLMModel(model: string): string {
  return GLM_MODEL_MAP[model] ?? model;
}

// ── Full env-based resolution ────────────────────────────────────────

/**
 * Scans environment variables and builds a MultiProviderConfig from them.
 * This replaces the server's `initializeProvidersFromEnv()` function.
 *
 * Note: This function only RETURNS the config. To actually configure providers,
 * call `configureProviders(resolveFromEnv())`.
 *
 * @returns MultiProviderConfig if any env vars are set, null otherwise.
 */
export function resolveFromEnv(): MultiProviderConfig | null {
  const config: Record<string, { apiKey: string; model?: string; baseUrl?: string }> = {};

  if (process.env.OPENAI_API_KEY) {
    config.openai = {
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.OPENAI_MODEL ?? DEFAULT_MODELS.openai,
    };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    config.anthropic = {
      apiKey: process.env.ANTHROPIC_API_KEY,
      model: process.env.ANTHROPIC_MODEL ?? DEFAULT_MODELS.anthropic,
    };
  }
  if (process.env.GLM_API_KEY) {
    config.glm = {
      apiKey: process.env.GLM_API_KEY,
      model: process.env.GLM_MODEL ?? DEFAULT_MODELS.glm,
    };
  }
  const compatApiKey = process.env.OPENAI_COMPAT_API_KEY || process.env.SEEPIENT_API_KEY;
  const compatBaseUrl = process.env.OPENAI_COMPAT_BASE_URL || process.env.OPENAI_BASE_URL;
  if (compatApiKey && compatBaseUrl) {
    if (process.env.SEEPIENT_API_KEY && !process.env.OPENAI_COMPAT_API_KEY) {
      console.warn("[seepient] SEEPIENT_API_KEY is deprecated. Use OPENAI_COMPAT_API_KEY instead.");
    }
    if (process.env.OPENAI_BASE_URL && !process.env.OPENAI_COMPAT_BASE_URL) {
      console.warn("[seepient] OPENAI_BASE_URL is deprecated. Use OPENAI_COMPAT_BASE_URL instead.");
    }
    config["openai-compatible"] = {
      apiKey: compatApiKey,
      baseUrl: compatBaseUrl,
      model: process.env.OPENAI_COMPAT_MODEL ?? process.env.LLM_MODEL ?? process.env.SEEPIENT_MODEL ?? DEFAULT_MODELS['openai-compatible'],
    };
  }

  if (Object.keys(config).length > 0) {
    const defaultProvider = ((process.env.LLM_PROVIDER ?? process.env.SEEPIENT_PROVIDER) as ProviderType) ??
      ((config.openai ? "openai" : Object.keys(config)[0]) as ProviderType);

    return {
      ...config,
      default: defaultProvider,
    } as MultiProviderConfig;
  }

  return null;
}
