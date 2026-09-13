/**
 * Provider runtime interface and core types — Foundations (Spec 021).
 *
 * Defines the strongly-typed contract for ProviderRuntime and plan resolution,
 * avoiding upward layer dependencies from Foundations to Domain.
 */

import type { CredentialStore } from "./credential-store.js";
import type { UpstreamModel, StreamEvent } from "../schemas/inference.js";
import type { ProviderEffectiveConfig, PurposeModelMap, ModelAssignmentOverride } from "../schemas/provider-config.js";
import type { InferenceTarget, LanguageRequest } from "./backend-ports.js";

export type { InferenceTarget, LanguageRequest, ModelAssignmentOverride };

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
  readonly warnings?: readonly string[];
}

/**
 * Public structural contract for ProviderRuntime across Seepient layers.
 */
export interface ProviderRuntimeContract {
  /**
   * true when this runtime was constructed by the isolated path (default
   * constructors or createIsolatedProviderRuntime); false only for
   * createAmbientProviderRuntime() output. Stamped at construction; multi-mode
   * roots require isIsolated === true on all injected runtimes and stores.
   */
  readonly isIsolated: boolean;
  createTurnSnapshot(): Promise<TurnSnapshot>;
  resolvePlan(
    snapshot: TurnSnapshot,
    purpose: Purpose | string,
    tier?: Tier | string,
    override?: ModelAssignmentOverride,
  ): Promise<InvocationPlan>;
  executeLanguage(
    plan: InvocationPlan,
    payload: LanguageRequest,
    options?: { signal?: AbortSignal },
  ): AsyncIterable<StreamEvent>;
  executeVendorOperation?(
    target: unknown,
    operation: string,
    payload: unknown,
    options?: { signal?: AbortSignal },
  ): Promise<unknown>;
  getConfig?(): Promise<ProviderEffectiveConfig>;
  getConfigStore?(): unknown;
  getCredentialStore?(): CredentialStore;
  modelCatalog?: {
    listAvailableModels(config: ProviderEffectiveConfig): Promise<import("../schemas/inference.js").AvailableModel[]>;
  };
  removeAllListeners?(): void;
}
