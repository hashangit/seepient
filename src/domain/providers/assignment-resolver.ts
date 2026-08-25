import type {
  InferenceTarget,
} from "../../foundations/contracts/backend-ports.js";
import type { CredentialStore } from "../../foundations/contracts/credential-store.js";
import type {
  PurposeModelMap,
  ModelAssignment,
  ModelAssignmentOverride,
} from "../../foundations/schemas/provider-config.js";
import type { UpstreamModel, ThinkingLevel } from "../../foundations/schemas/inference.js";
import type { ProviderEffectiveConfig } from "../../foundations/schemas/provider-config.js";
import { SeepientError, InferenceError } from "../../foundations/errors.js";
import { normalizeProviderName } from "../../foundations/models-catalog.js";

export type Purpose =
  | "plan"
  | "text"
  | "coding"
  | "vision"
  | "commit"
  | "image-generation"
  | "video-generation"
  | "tts"
  | "stt"
  | "dreaming"
  | "data"
  | "media.image"
  | "media.speech"
  | "media.transcription"
  | "media.video";

export type Tier = "efficient" | "standard" | "complex";

export interface TurnSnapshot {
  revision: number;
  createdAt: string;
  catalog: readonly UpstreamModel[];
  config: ProviderEffectiveConfig;
  assignments: PurposeModelMap;
}

export interface InvocationPlan {
  readonly selectedTarget: InferenceTarget;
  readonly failureTargets: readonly InferenceTarget[];
  readonly snapshot?: TurnSnapshot;
}

/**
 * Resolves an immutable InvocationPlan for an agent step based on snapshot, purpose, tier, and overrides.
 */
export async function resolveInvocationPlan(
  snapshot: TurnSnapshot,
  credentialStore: CredentialStore,
  purpose: Purpose,
  tier: Tier = "standard",
  override?: ModelAssignmentOverride,
): Promise<InvocationPlan> {
  const accounts = snapshot.config.providers || {};

  // 1. Resolve base assignment from PurposeModelMap
  let assignment: ModelAssignment | undefined;
  const assignments = snapshot.assignments as Record<string, any>;

  if (
    purpose === "plan" ||
    purpose === "text" ||
    purpose === "coding" ||
    purpose === "vision" ||
    purpose === "commit" ||
    purpose === "dreaming" ||
    purpose === "data"
  ) {
    const tiered = assignments[purpose] ?? (purpose === "coding" ? assignments.text : undefined);
    if (tiered) {
      // Selection fallback: requested -> standard -> efficient -> complex
      const tierOrder: Tier[] = [tier, "standard", "efficient", "complex"];
      for (const t of tierOrder) {
        if (tiered[t]) {
          assignment = tiered[t];
          break;
        }
      }
    }
  } else {
    // Single-slot media purposes (image-generation / media.image, etc.)
    const mediaMap = assignments.media;
    if (purpose === "image-generation" || purpose === "media.image") {
      assignment = assignments["image-generation"]?.standard ?? assignments["image-generation"] ?? mediaMap?.image;
    } else if (purpose === "tts" || purpose === "media.speech") {
      assignment = assignments.tts?.standard ?? assignments.tts ?? mediaMap?.speech;
    } else if (purpose === "stt" || purpose === "media.transcription") {
      assignment = assignments.stt?.standard ?? assignments.stt ?? mediaMap?.transcription;
    } else if (purpose === "video-generation" || purpose === "media.video") {
      assignment = assignments["video-generation"]?.standard ?? assignments["video-generation"] ?? mediaMap?.video;
    }
  }

  // Synthesize assignment if full override is provided without purpose mapping
  if (!assignment && override?.providerAccount && override?.model) {
    assignment = {
      providerAccount: override.providerAccount,
      model: override.model,
      thinkingLevel: override.thinkingLevel,
    };
  }

  if (!assignment) {
    throw new InferenceError({
      code: "unconfigured_purpose",
      message: `No model assignment configured for purpose "${purpose}" (tier "${tier}")`,
      retryable: false,
    });
  }

  // Apply partial or complete overrides
  const effectiveAccount = override?.providerAccount ?? assignment.providerAccount;
  const effectiveModel = override?.model ?? assignment.model;
  const effectiveThinking = (override?.thinkingLevel ?? assignment.thinkingLevel) as ThinkingLevel | undefined;

  const mainAcc = accounts[effectiveAccount];
  if (!mainAcc) {
    throw new InferenceError({
      code: "unconfigured_provider",
      message: `Provider account "${effectiveAccount}" is not configured`,
      providerAccount: effectiveAccount,
      model: effectiveModel,
      retryable: false,
    });
  }

  // Capability gating & thinking level validation on selected target (QS-P5.1)
  validateTargetCapabilities(
    snapshot.catalog,
    purpose,
    effectiveAccount,
    mainAcc.upstreamProvider,
    effectiveModel,
    effectiveThinking,
  );

  const mainCredHandle = await credentialStore.resolve(mainAcc.credential);
  const selectedTarget: InferenceTarget = {
    providerAccount: effectiveAccount,
    upstreamProvider: mainAcc.upstreamProvider,
    model: effectiveModel,
    credential: mainCredHandle,
    baseUrl: mainAcc.baseUrl,
    compat: mainAcc.compat,
    thinkingLevel: effectiveThinking,
  };

  // 2. Resolve explicit fallback targets (only when not overriding specific target)
  const failureTargets: InferenceTarget[] = [];
  if (!override?.model && !override?.providerAccount) {
    for (const fb of assignment.fallback || []) {
      try {
        const fbAcc = accounts[fb.providerAccount];
        if (!fbAcc) continue;

        // Validate fallback target capabilities
        validateTargetCapabilities(
          snapshot.catalog,
          purpose,
          fb.providerAccount,
          fbAcc.upstreamProvider,
          fb.model,
          fb.thinkingLevel as ThinkingLevel,
        );

        const fbCredHandle = await credentialStore.resolve(fbAcc.credential);
        failureTargets.push({
          providerAccount: fb.providerAccount,
          upstreamProvider: fbAcc.upstreamProvider,
          model: fb.model,
          credential: fbCredHandle,
          baseUrl: fbAcc.baseUrl,
          compat: fbAcc.compat,
          thinkingLevel: fb.thinkingLevel as ThinkingLevel,
        });
      } catch {
        // Fallback target resolution is best-effort — a failing fallback never fails the primary target
      }
    }
  }

  return {
    selectedTarget,
    failureTargets,
    snapshot,
  };
}

function validateTargetCapabilities(
  catalog: readonly UpstreamModel[],
  purpose: Purpose,
  accountName: string,
  upstreamProvider: string,
  modelId: string,
  thinkingLevel?: ThinkingLevel,
): void {
  const aliased = normalizeProviderName(upstreamProvider);
  const matchingProvider = (m: UpstreamModel) =>
    m.upstreamProvider === upstreamProvider ||
    m.upstreamProvider === aliased ||
    m.upstreamProvider === accountName;

  const catalogModel =
    catalog.find(
      (m) =>
        matchingProvider(m) &&
        (m.id.toLowerCase() === modelId.toLowerCase() ||
          m.id.toLowerCase().startsWith(modelId.toLowerCase() + "-") ||
          modelId.toLowerCase().startsWith(m.id.toLowerCase() + "-")),
    ) ||
    (catalog.length > 0 && !upstreamProvider
      ? catalog.find(
          (m) =>
            m.id.toLowerCase() === modelId.toLowerCase() ||
            m.id.toLowerCase().startsWith(modelId.toLowerCase() + "-"),
        )
      : undefined);

  if (!catalogModel) {
    const candidates = catalog
      .filter(
        (m) =>
          m.upstreamProvider === upstreamProvider ||
          m.upstreamProvider === aliased ||
          m.upstreamProvider === accountName,
      )
      .map((m) => m.id);
    if (candidates.length > 0) {
      const suggestions = candidates.slice(0, 3).join(", ");
      throw new InferenceError({
        code: "unknown_model",
        message: `Unknown model "${modelId}" for provider account "${accountName}". Did you mean: ${suggestions || "none"}? You can also declare custom models in settings.`,
        providerAccount: accountName,
        model: modelId,
        retryable: false,
      });
    }
    return;
  }

  if (
    (purpose === "text" || purpose === "plan" || purpose === "commit") &&
    catalogModel.capabilities.toolUse === false
  ) {
    throw new InferenceError({
      code: "unsupported_capability",
      message: `Model "${modelId}" does not support tool use required for purpose "${purpose}"`,
      providerAccount: accountName,
      model: modelId,
      retryable: false,
    });
  }

  if (purpose === "vision" && catalogModel.capabilities.vision === false) {
    throw new InferenceError({
      code: "unsupported_capability",
      message: `Model "${modelId}" does not support vision required for purpose "vision"`,
      providerAccount: accountName,
      model: modelId,
      retryable: false,
    });
  }

  if (purpose === "image-generation" && catalogModel.capabilities.imageGenerate === false) {
    throw new InferenceError({
      code: "unsupported_capability",
      message: `Model "${modelId}" does not support image generation`,
      providerAccount: accountName,
      model: modelId,
      retryable: false,
    });
  }

  if (thinkingLevel && thinkingLevel !== "none") {
    const supported = catalogModel.supportedReasoningLevels || ["none"];
    if (!supported.includes(thinkingLevel)) {
      throw new InferenceError({
        code: "unsupported_thinking_level",
        message: `Model "${modelId}" does not support thinking level "${thinkingLevel}". Supported: ${supported.join(", ")}`,
        providerAccount: accountName,
        model: modelId,
        retryable: false,
      });
    }
  }
}
