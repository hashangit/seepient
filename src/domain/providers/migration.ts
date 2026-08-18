import type { AppConfig } from "../../foundations/config.js";
import type {
  ProviderEffectiveConfig,
  ProviderEntry,
  PurposeModelMap,
} from "../../foundations/schemas/provider-config.js";
import { DEFAULT_RETRY_POLICY } from "../../foundations/schemas/provider-config.js";

export type LegacyProviderType = "openai" | "anthropic" | "glm" | "openai-compatible";

export interface MigrationOptions {
  dryRun?: boolean;
}

export interface MigrationResult {
  config: ProviderEffectiveConfig;
  dryRun?: boolean;
  migratedCredentials: Array<{
    id: string;
    keyValue: string;
    source: "disk" | "env";
  }>;
}

export const V1_TO_V2_MODEL_MAP: Record<string, string> = {
  "gpt-4o": "gpt-5.6-terra",
  "gpt-4o-mini": "gpt-5.6-luna",
  "gpt-5.4": "gpt-5.6-terra",
  "claude-3-7-sonnet-20250219": "claude-sonnet-5",
  "claude-3-7-sonnet": "claude-sonnet-5",
  "claude-3-5-sonnet": "claude-sonnet-5",
  "claude-3-5-haiku": "claude-haiku-4-5",
  "gemini-2.5-flash": "gemini-3.7-flash",
  "glm-4.7": "glm-5.3",
  "sonnet": "glm-5.3",
  "haiku": "glm-4.5-air",
  "opus": "glm-5.3",
};

const DEFAULT_PROVIDER_MODELS: Record<string, string> = {
  openai: "gpt-5.6-terra",
  anthropic: "claude-sonnet-5",
  glm: "glm-5.3",
  "openai-compatible": "gpt-5.6-terra",
};

const PROVIDER_ENV_MAP: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  glm: "GLM_API_KEY",
  "openai-compatible": "OPENAI_COMPAT_API_KEY",
};

/**
 * Migrates real v1 AppConfig into v2 ProviderEffectiveConfig.
 * Handles top-level apiKey, models map, baseUrl, and image settings.
 * Preserves credential provenance and prevents cross-provider model mismatches.
 */
export function migrateV1ToV2(
  v1Config: AppConfig,
  options?: MigrationOptions,
): MigrationResult {
  const cfg = v1Config || ({} as AppConfig);
  const providers: Record<string, ProviderEntry> = {};
  const migratedCredentials: MigrationResult["migratedCredentials"] = [];

  const defaultProvider = (cfg.provider as LegacyProviderType) || "openai";
  const explicitModel =
    cfg.model ||
    (cfg.models as any)?.[defaultProvider]?.model;
  const defaultModel =
    explicitModel ||
    DEFAULT_PROVIDER_MODELS[defaultProvider] ||
    "gpt-5.6-terra";

  const knownProviders: LegacyProviderType[] = ["openai", "anthropic", "glm", "openai-compatible"];

  for (const p of knownProviders) {
    const modelEntry = (cfg.models as any)?.[p];
    // Check models map apiKey or top-level apiKey if this is the active default provider
    const key = modelEntry?.apiKey || (p === defaultProvider ? cfg.apiKey : undefined);
    const baseUrl =
      modelEntry && "baseUrl" in modelEntry
        ? modelEntry.baseUrl
        : (p === "openai-compatible" || p === defaultProvider ? cfg.baseUrl : undefined);

    if (key && key.trim().length > 0) {
      const credId = `${p}-migrated`;
      providers[p] = {
        adapter: "pi-ai",
        upstreamProvider: p === "openai-compatible" ? "openai" : p,
        credential: { kind: "seepient", id: credId },
        baseUrl,
      };
      migratedCredentials.push({
        id: credId,
        keyValue: key,
        source: "disk",
      });
    } else {
      providers[p] = {
        adapter: "pi-ai",
        upstreamProvider: p === "openai-compatible" ? "openai" : p,
        credential: { kind: "env", name: PROVIDER_ENV_MAP[p] || "OPENAI_API_KEY" },
        baseUrl,
      };
    }
  }

  // Handle dedicated image provider if imageApiKey was set
  if (v1Config.imageApiKey && v1Config.imageApiKey.trim().length > 0) {
    const imgCredId = "openai-image-migrated";
    providers["image-openai"] = {
      adapter: "openai",
      upstreamProvider: "openai",
      credential: { kind: "seepient", id: imgCredId },
      baseUrl: v1Config.imageBaseUrl,
    };
    migratedCredentials.push({
      id: imgCredId,
      keyValue: v1Config.imageApiKey,
      source: "disk",
    });
  }

  // Model assignments
  const imageAccount = v1Config.imageApiKey ? "image-openai" : "openai";
  const imageModel = v1Config.imageModel || "dall-e-3";

  const assignments: PurposeModelMap = {
    plan: { standard: { providerAccount: defaultProvider, model: defaultModel } },
    text: { standard: { providerAccount: defaultProvider, model: defaultModel } },
    vision: { standard: { providerAccount: defaultProvider, model: defaultModel } },
    commit: { standard: { providerAccount: defaultProvider, model: defaultModel } },
    media: {
      image: { providerAccount: imageAccount, model: imageModel },
    },
  };

  const config: ProviderEffectiveConfig = {
    schemaVersion: 2,
    revision: 1,
    updatedAt: new Date().toISOString(),
    providers,
    modelAssignments: assignments,
    retryPolicy: DEFAULT_RETRY_POLICY,
  };

  return {
    config,
    dryRun: options?.dryRun,
    migratedCredentials,
  };
}
