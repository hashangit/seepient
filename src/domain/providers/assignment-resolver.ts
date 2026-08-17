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

export type Purpose =
  | "plan"
  | "text"
  | "vision"
  | "commit"
  | "image-generation"
  | "video-generation"
  | "tts"
  | "stt"
  | "dreaming"
  | "data";

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
    purpose === "vision" ||
    purpose === "commit" ||
    purpose === "dreaming" ||
    purpose === "data"
  ) {
    const tiered = assignments[purpose];
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
    // Single-slot media purposes (image-generation -> media.image, etc.)
    const mediaMap = assignments.media;
    if (purpose === "image-generation") assignment = mediaMap?.image ?? assignments["image-generation"];
    else if (purpose === "tts") assignment = mediaMap?.speech ?? assignments.tts;
    else if (purpose === "stt") assignment = mediaMap?.transcription ?? assignments.stt;
    else if (purpose === "video-generation") assignment = mediaMap?.video ?? assignments["video-generation"];
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
    throw new SeepientError(
      `No model assignment configured for purpose "${purpose}" (tier "${tier}")`,
      "UNCONFIGURED_PURPOSE",
      false,
    );
  }

  // Apply partial or complete overrides
  const effectiveAccount = override?.providerAccount ?? assignment.providerAccount;
  const effectiveModel = override?.model ?? assignment.model;
  const effectiveThinking = (override?.thinkingLevel ?? assignment.thinkingLevel) as ThinkingLevel | undefined;

  const mainAcc = accounts[effectiveAccount];
  if (!mainAcc) {
    throw new SeepientError(
      `Provider account "${effectiveAccount}" is not configured`,
      "UNRESOLVABLE_CREDENTIAL",
      false,
    );
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
      const fbAcc = accounts[fb.providerAccount];
      if (fbAcc) {
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
  const catalogModel =
    catalog.find(
      (m) =>
        m.id === modelId &&
        (m.upstreamProvider === upstreamProvider || m.upstreamProvider === accountName),
    ) || (catalog.length > 0 && !upstreamProvider ? catalog.find((m) => m.id === modelId) : undefined);

  if (catalogModel) {
    if (
      (purpose === "text" || purpose === "plan" || purpose === "commit" || purpose === "vision") &&
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
}
