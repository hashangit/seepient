import type {
  LanguageRequest,
  InferenceOptions,
  BoundAdapter,
} from "../../foundations/contracts/backend-ports.js";
import type {
  StreamEvent,
  ImageRequest,
  ImageResult,
} from "../../foundations/schemas/inference.js";
import type { CredentialStore } from "../../foundations/contracts/credential-store.js";
import { InferenceError } from "../../foundations/errors.js";
import { AggregateInferenceAdapter } from "../../capabilities/inference/aggregate-adapter.js";
import { ProviderConfigStore } from "./config-store/provider-config-store.js";
import { ModelCatalog } from "./model-catalog.js";
import { CompositeCredentialStore } from "./credentials/composite-credential-store.js";
import {
  type TurnSnapshot,
  type InvocationPlan,
  type Purpose,
  type Tier,
  resolveInvocationPlan,
} from "./assignment-resolver.js";
import type { ModelAssignmentOverride } from "../../foundations/schemas/provider-config.js";

export interface ProviderRuntimeOptions {
  configStore?: ProviderConfigStore;
  credentialStore?: CredentialStore;
  modelCatalog?: ModelCatalog;
  adapter?: AggregateInferenceAdapter;
}

export interface CapabilityHealth {
  consecutiveFailures: number;
  cooldownUntil?: number;
}

/**
 * Central ProviderRuntime managing turn snapshots, plan resolution, execution dispatch,
 * and multi-target retries with cooldown tracking.
 */
export class ProviderRuntime {
  readonly configStore: ProviderConfigStore;
  readonly credentialStore: CredentialStore;
  readonly modelCatalog: ModelCatalog;
  readonly adapter: AggregateInferenceAdapter;

  private healthMap = new Map<string, CapabilityHealth>();

  constructor(options?: ProviderRuntimeOptions) {
    this.configStore = options?.configStore ?? new ProviderConfigStore();
    this.credentialStore = options?.credentialStore ?? new CompositeCredentialStore();
    this.modelCatalog = options?.modelCatalog ?? new ModelCatalog();
    this.adapter = options?.adapter ?? new AggregateInferenceAdapter();
  }

  private healthKey(account: string, capability: string): string {
    return `${account}:${capability}`;
  }

  getHealth(account: string, capability: string): CapabilityHealth {
    const key = this.healthKey(account, capability);
    return this.healthMap.get(key) ?? { consecutiveFailures: 0 };
  }

  private recordSuccess(account: string, capability: string): void {
    const key = this.healthKey(account, capability);
    this.healthMap.set(key, { consecutiveFailures: 0 });
  }

  private recordFailure(account: string, capability: string, cooldownDurationMs = 60_000): void {
    const key = this.healthKey(account, capability);
    const existing = this.healthMap.get(key) ?? { consecutiveFailures: 0 };
    const consecutive = existing.consecutiveFailures + 1;
    const cooldownUntil = consecutive >= 3 ? Date.now() + cooldownDurationMs : undefined;

    this.healthMap.set(key, {
      consecutiveFailures: consecutive,
      cooldownUntil,
    });
  }

  /**
   * Creates an immutable TurnSnapshot pinned for the duration of a conversation turn.
   */
  async createTurnSnapshot(): Promise<TurnSnapshot> {
    const config = await this.configStore.getEffectiveConfig();
    const catalog = await this.modelCatalog.getAllModels();

    return {
      revision: config.revision,
      createdAt: new Date().toISOString(),
      catalog,
      config,
      assignments: config.modelAssignments || {},
    };
  }

  /**
   * Resolves an InvocationPlan for a step.
   */
  async resolvePlan(
    snapshot: TurnSnapshot,
    purpose: Purpose,
    tier: Tier = "standard",
    override?: ModelAssignmentOverride,
  ): Promise<InvocationPlan> {
    return resolveInvocationPlan(snapshot, this.credentialStore, purpose, tier, override);
  }

  /**
   * Executes a streaming language call across the plan's targets with automatic fallback.
   */
  async *executeLanguage(
    plan: InvocationPlan,
    req: LanguageRequest,
    opts?: InferenceOptions,
  ): AsyncIterable<StreamEvent> {
    const targets = [plan.selectedTarget, ...plan.failureTargets];
    let lastError: any;

    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      const health = this.getHealth(target.providerAccount, "language");

      if (health.cooldownUntil && health.cooldownUntil > Date.now() && i < targets.length - 1) {
        // Skip cooled down target if we have another fallback available
        continue;
      }

      let bound: BoundAdapter;
      try {
        bound = await this.adapter.bind(target);
      } catch (err: any) {
        lastError = err;
        this.recordFailure(target.providerAccount, "language");
        continue;
      }

      if (!bound.language) {
        lastError = new InferenceError({
          code: "unsupported_capability",
          message: `Target ${target.providerAccount}:${target.model} does not support language`,
          providerAccount: target.providerAccount,
          model: target.model,
          retryable: false,
        });
        this.recordFailure(target.providerAccount, "language");
        continue;
      }

      let emittedAnyDelta = false;
      try {
        for await (const event of bound.language.stream(req, opts)) {
          if (event.type === "content_block_delta") {
            emittedAnyDelta = true;
          }
          if (event.type === "error" && !emittedAnyDelta && i < targets.length - 1 && event.error.retryable) {
            // Can fallback to next target if no tokens were emitted yet
            throw new InferenceError({
              code: event.error.code as any,
              message: event.error.message,
              providerAccount: target.providerAccount,
              model: target.model,
              retryable: true,
            });
          }
          yield event;
        }

        this.recordSuccess(target.providerAccount, "language");
        return;
      } catch (err: any) {
        lastError = err;
        this.recordFailure(target.providerAccount, "language");

        if (emittedAnyDelta || i === targets.length - 1) {
          // If streaming already started, or this is the last target, yield the error event
          yield {
            type: "error",
            error: {
              code: err instanceof InferenceError ? err.code : "internal_adapter",
              message: err?.message || "Execution failed",
              retryable: false,
            },
          };
          return;
        }
      }
    }

    if (lastError) {
      yield {
        type: "error",
        error: {
          code: lastError instanceof InferenceError ? lastError.code : "internal_adapter",
          message: lastError?.message || "All inference targets failed",
          retryable: false,
        },
      };
    }
  }

  /**
   * Executes an image generation call across the plan's targets with automatic fallback.
   */
  async executeImage(
    plan: InvocationPlan,
    req: ImageRequest,
    opts?: InferenceOptions,
  ): Promise<ImageResult> {
    const targets = [plan.selectedTarget, ...plan.failureTargets];
    let lastError: any;

    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      try {
        const bound = await this.adapter.bind(target);
        if (!bound.images) {
          throw new InferenceError({
            code: "unsupported_capability",
            message: `Target ${target.providerAccount}:${target.model} does not support images`,
            providerAccount: target.providerAccount,
            model: target.model,
            retryable: false,
          });
        }

        const result = await bound.images.generate(req, opts);
        this.recordSuccess(target.providerAccount, "image");
        return result;
      } catch (err: any) {
        lastError = err;
        this.recordFailure(target.providerAccount, "image");
        if (i === targets.length - 1) {
          throw err;
        }
      }
    }

    throw lastError ?? new InferenceError({
      code: "internal_adapter",
      message: "All image targets failed",
      providerAccount: plan.selectedTarget.providerAccount,
      model: plan.selectedTarget.model,
      retryable: false,
    });
  }

  async executeSpeech(): Promise<never> {
    throw new InferenceError({
      code: "unsupported_capability",
      message: "Speech synthesis (TTS) is coming soon in v2",
      retryable: false,
    });
  }

  async executeTranscription(): Promise<never> {
    throw new InferenceError({
      code: "unsupported_capability",
      message: "Speech transcription (STT) is coming soon in v2",
      retryable: false,
    });
  }

  async executeVideo(): Promise<never> {
    throw new InferenceError({
      code: "unsupported_capability",
      message: "Video generation is coming soon in v2",
      retryable: false,
    });
  }
}
