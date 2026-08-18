import type { AppConfig } from "../../foundations/config.js";
import { resolveActiveProviderType } from "../../foundations/config.js";
import type {
  ProviderEffectiveConfig,
  ProviderEntry,
  PurposeModelMap,
} from "../../foundations/schemas/provider-config.js";
import { DEFAULT_RETRY_POLICY } from "../../foundations/schemas/provider-config.js";
import {
  resolveDefaultModelForProvider,
  normalizeProviderName,
} from "../../foundations/models-catalog.js";
import { getSyncBuiltinCatalog } from "./model-catalog.js";

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
  remapNotes?: Record<string, string>;
}

const PROVIDER_ENV_MAP: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  glm: "GLM_API_KEY",
  "openai-compatible": "OPENAI_COMPAT_API_KEY",
};

/**
 * Dynamically resolves a model id during migration:
 * If the model id is present in the catalog under the aliased provider, pass through;
 * otherwise resolve to the provider policy default and record a remap note.
 */
export function resolveMigratedModel(
  provider: string,
  modelId?: string,
  tier: "efficient" | "standard" | "complex" = "standard",
): { model: string; remapped: boolean; original?: string } {
  const catalog = getSyncBuiltinCatalog();
  const aliasedProvider = normalizeProviderName(provider);

  if (modelId && typeof modelId === "string" && modelId.trim().length > 0) {
    const trimmed = modelId.trim();
    if (provider === "openai-compatible" || aliasedProvider === "openai-compatible") {
      return { model: trimmed, remapped: false };
    }
    // Check if directly in catalog
    const inCatalog = catalog.some(
      (m) =>
        (m.upstreamProvider === provider || m.upstreamProvider === aliasedProvider) &&
        m.id.toLowerCase() === trimmed.toLowerCase(),
    );
    if (inCatalog) {
      return { model: trimmed, remapped: false };
    }
  }

  // Not in catalog or shorthand -> policy default
  const defaultModel = resolveDefaultModelForProvider(catalog, provider, tier);
  return {
    model: defaultModel,
    remapped: modelId !== defaultModel,
    original: modelId,
  };
}

/**
 * Migrates real v1 AppConfig into v2 ProviderEffectiveConfig.
 * Handles top-level apiKey, models map, baseUrl, and image settings.
 * Preserves credential provenance and dynamically remaps deprecated models.
 */
export function migrateV1ToV2(
  v1Config: AppConfig,
  options?: MigrationOptions,
): MigrationResult {
  const cfg = v1Config || ({} as AppConfig);
  const providers: Record<string, ProviderEntry> = {};
  const migratedCredentials: MigrationResult["migratedCredentials"] = [];
  const remapNotes: Record<string, string> = {};

  const defaultProvider = resolveActiveProviderType(cfg);
  const explicitModel =
    cfg.model ||
    (cfg.models as any)?.[defaultProvider]?.model;

  const modelResolution = resolveMigratedModel(defaultProvider, explicitModel, "standard");
  const defaultModel = modelResolution.model;
  if (modelResolution.remapped && modelResolution.original) {
    remapNotes[defaultProvider] = `Remapped v1 model "${modelResolution.original}" to catalog default "${defaultModel}"`;
  }

  const knownProviders: LegacyProviderType[] = ["openai", "anthropic", "glm", "openai-compatible"];

  for (const p of knownProviders) {
    const modelEntry = (cfg.models as any)?.[p];
    const key = modelEntry?.apiKey || (p === defaultProvider ? cfg.apiKey : undefined);
    let baseUrl =
      modelEntry && "baseUrl" in modelEntry
        ? modelEntry.baseUrl
        : (p === "openai-compatible" || p === defaultProvider ? cfg.baseUrl : undefined);

    if (p === "openai-compatible" && !baseUrl && process.env.OPENAI_COMPAT_BASE_URL) {
      baseUrl = process.env.OPENAI_COMPAT_BASE_URL;
    }

    if (key && key.trim().length > 0) {
      const credId = `${p}-migrated`;
      providers[p] = {
        adapter: "pi-ai",
        upstreamProvider: p === "openai-compatible" ? "openai" : normalizeProviderName(p),
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
        upstreamProvider: p === "openai-compatible" ? "openai" : normalizeProviderName(p),
        credential: { kind: "env", name: PROVIDER_ENV_MAP[p] || "OPENAI_API_KEY" },
        baseUrl,
      };
    }
  }

  // Dedicated image provider if imageApiKey was set
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
  const imageModel = v1Config.imageModel || "gpt-image-2";

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
    revision: 0,
    updatedAt: new Date().toISOString(),
    providers,
    modelAssignments: assignments,
    retryPolicy: DEFAULT_RETRY_POLICY,
  };

  return {
    config,
    dryRun: options?.dryRun,
    migratedCredentials,
    remapNotes: Object.keys(remapNotes).length > 0 ? remapNotes : undefined,
  };
}
