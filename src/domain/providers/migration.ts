import type {
  ProviderEffectiveConfig,
  ProviderEntry,
  PurposeModelMap,
} from "../../foundations/schemas/provider-config.js";
import { DEFAULT_RETRY_POLICY } from "../../foundations/schemas/provider-config.js";

export interface MigrationOptions {
  dryRun?: boolean;
}

export interface MigrationResult {
  config: ProviderEffectiveConfig;
  migratedCredentials: Array<{
    id: string;
    keyValue: string;
    source: "disk" | "env";
  }>;
}

/**
 * Migrates v1 configuration into v2 ProviderEffectiveConfig.
 * Preserves source provenance (meta.source) for all migrated credentials.
 */
export function migrateV1ToV2(
  v1Config: any,
  _options?: MigrationOptions,
): MigrationResult {
  const providers: Record<string, ProviderEntry> = {};
  const migratedCredentials: MigrationResult["migratedCredentials"] = [];

  const defaultProvider =
    v1Config?.llm?.provider || v1Config?.defaultProvider || v1Config?.default || "openai";
  const defaultModel =
    v1Config?.llm?.model || v1Config?.models?.[defaultProvider]?.model || "gpt-4o";

  // Provider mappings
  const knownProviders = ["openai", "anthropic", "glm", "openai-compatible"];
  for (const p of knownProviders) {
    const v1Key =
      v1Config?.[`${p}ApiKey`] ||
      v1Config?.[`${p}Key`] ||
      v1Config?.apiKeys?.[p] ||
      v1Config?.models?.[p]?.apiKey;

    const envVarName =
      p === "openai"
        ? "OPENAI_API_KEY"
        : p === "anthropic"
          ? "ANTHROPIC_API_KEY"
          : p === "glm"
            ? "GLM_API_KEY"
            : "OPENAI_COMPAT_API_KEY";

    if (v1Key) {
      const credId = `${p}-migrated`;
      providers[p] = {
        adapter: "pi-ai",
        upstreamProvider: p === "openai-compatible" ? "openai" : p,
        credential: { kind: "seepient", id: credId },
        baseUrl: p === "openai-compatible" ? v1Config?.openaiCompatBaseUrl : undefined,
      };
      migratedCredentials.push({
        id: credId,
        keyValue: v1Key,
        source: "disk",
      });
    } else {
      providers[p] = {
        adapter: "pi-ai",
        upstreamProvider: p === "openai-compatible" ? "openai" : p,
        credential: { kind: "env", name: envVarName },
        baseUrl: p === "openai-compatible" ? v1Config?.openaiCompatBaseUrl : undefined,
      };
    }
  }

  // Model assignments (default provider/model becomes standard tier for all agentic purposes)
  const assignments: PurposeModelMap = {
    plan: { standard: { providerAccount: defaultProvider, model: defaultModel } },
    text: { standard: { providerAccount: defaultProvider, model: defaultModel } },
    coding: { standard: { providerAccount: defaultProvider, model: defaultModel } },
    vision: { standard: { providerAccount: defaultProvider, model: defaultModel } },
    commit: { standard: { providerAccount: defaultProvider, model: defaultModel } },
    media: {
      image: { providerAccount: "openai", model: "dall-e-3" },
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
    migratedCredentials,
  };
}
