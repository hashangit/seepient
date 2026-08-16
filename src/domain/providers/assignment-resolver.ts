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
import { SeepientError } from "../../foundations/errors.js";

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

  // 1. If override is specified
  if (override?.model && override?.providerAccount) {
    const accEntry = accounts[override.providerAccount];
    if (!accEntry) {
      throw new SeepientError(
        `Provider account "${override.providerAccount}" specified in override is not configured`,
        "UNRESOLVABLE_CREDENTIAL",
        false,
      );
    }

    const credHandle = await credentialStore.resolve(accEntry.credential);
    const selectedTarget: InferenceTarget = {
      providerAccount: override.providerAccount,
      upstreamProvider: accEntry.upstreamProvider,
      model: override.model,
      credential: credHandle,
      baseUrl: accEntry.baseUrl,
      compat: accEntry.compat,
      thinkingLevel: override.thinkingLevel,
    };

    return {
      selectedTarget,
      failureTargets: [],
    };
  }

  // 2. Resolve assignment from PurposeModelMap
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

  if (!assignment) {
    throw new SeepientError(
      `No model assignment configured for purpose "${purpose}" (tier "${tier}")`,
      "UNCONFIGURED_PURPOSE",
      false,
    );
  }

  const mainAcc = accounts[assignment.providerAccount];
  if (!mainAcc) {
    throw new SeepientError(
      `Provider account "${assignment.providerAccount}" assigned to purpose "${purpose}" is not configured`,
      "UNRESOLVABLE_CREDENTIAL",
      false,
    );
  }

  const mainCredHandle = await credentialStore.resolve(mainAcc.credential);
  const selectedTarget: InferenceTarget = {
    providerAccount: assignment.providerAccount,
    upstreamProvider: mainAcc.upstreamProvider,
    model: assignment.model,
    credential: mainCredHandle,
    baseUrl: mainAcc.baseUrl,
    compat: mainAcc.compat,
    thinkingLevel: (override?.thinkingLevel ?? assignment.thinkingLevel) as ThinkingLevel,
  };

  // 3. Resolve explicit fallback targets
  const failureTargets: InferenceTarget[] = [];
  for (const fb of assignment.fallback || []) {
    const fbAcc = accounts[fb.providerAccount];
    if (fbAcc) {
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

  return {
    selectedTarget,
    failureTargets,
  };
}
