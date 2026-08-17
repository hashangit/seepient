import type {
  LanguageRequest,
  InferenceOptions,
  BoundAdapter,
} from "../../foundations/contracts/backend-ports.js";
import type {
  StreamEvent,
  ImageRequest,
  ImageResult,
  UpstreamModel,
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
import {
  type ModelAssignmentOverride,
  DEFAULT_RETRY_POLICY,
} from "../../foundations/schemas/provider-config.js";

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
 * and multi-target retries with cooldown tracking and dynamic catalog synchronization.
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

  private recordFailure(
    account: string,
    capability: string,
    cooldownThreshold = 3,
    cooldownDurationMs = 60_000,
  ): void {
    const key = this.healthKey(account, capability);
    const existing = this.healthMap.get(key) ?? { consecutiveFailures: 0 };
    const consecutive = existing.consecutiveFailures + 1;
    const cooldownUntil = consecutive >= cooldownThreshold ? Date.now() + cooldownDurationMs : undefined;

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

    const userDeclared: UpstreamModel[] = [];
    const accounts = config.providers || {};
    for (const [accId, entry] of Object.entries(accounts)) {
      if (entry.models && Array.isArray(entry.models)) {
        for (const m of entry.models) {
          userDeclared.push({
            ...m,
            upstreamProvider: entry.upstreamProvider || accId,
            provenance: "user-declared",
          });
        }
      }
    }

    const catalog = await this.modelCatalog.getAllModels(userDeclared);

    // Synchronize catalog with aggregate adapter so dynamic models route accurately
    this.adapter.updateCatalog(catalog);

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
    const retryPolicy = plan.snapshot?.config?.retryPolicy ?? DEFAULT_RETRY_POLICY;

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
        this.recordFailure(
          target.providerAccount,
          "language",
          retryPolicy.cooldownThreshold,
          retryPolicy.cooldownDurationMs,
        );
        if (err instanceof InferenceError && !err.retryable) {
          yield {
            type: "error",
            error: {
              code: err.code,
              message: err.message,
              retryable: false,
            },
          };
          return;
        }
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
        this.recordFailure(
          target.providerAccount,
          "language",
          retryPolicy.cooldownThreshold,
          retryPolicy.cooldownDurationMs,
        );
        continue;
      }

      let emittedAnyDelta = false;
      let hadError = false;

      try {
        for await (const event of bound.language.stream(req, opts)) {
          if (event.type === "content_block_delta") {
            emittedAnyDelta = true;
          }
          if (event.type === "error") {
            hadError = true;
            this.recordFailure(
              target.providerAccount,
              "language",
              retryPolicy.cooldownThreshold,
              retryPolicy.cooldownDurationMs,
            );

            if (!emittedAnyDelta && i < targets.length - 1 && event.error.retryable) {
              // Fallback to next candidate if no tokens were emitted yet
              throw new InferenceError({
                code: event.error.code as any,
                message: event.error.message,
                providerAccount: target.providerAccount,
                model: target.model,
                retryable: true,
              });
            } else {
              // Yield error and terminate stream immediately
              yield event;
              return;
            }
          }
          yield event;
        }

        if (!hadError) {
          this.recordSuccess(target.providerAccount, "language");
          return;
        }
      } catch (err: any) {
        lastError = err;
        this.recordFailure(
          target.providerAccount,
          "language",
          retryPolicy.cooldownThreshold,
          retryPolicy.cooldownDurationMs,
        );

        const isRetryable = err instanceof InferenceError ? err.retryable : true;
        if (opts?.signal?.aborted && opts.signal.reason?.name !== "TimeoutError") {
          // User aborted — do not fall through to next targets
          yield {
            type: "abort",
            reason: "user",
          };
          return;
        }

        if (emittedAnyDelta || i === targets.length - 1 || !isRetryable) {
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
    const retryPolicy = plan.snapshot?.config?.retryPolicy ?? DEFAULT_RETRY_POLICY;

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
        this.recordFailure(
          target.providerAccount,
          "image",
          retryPolicy.cooldownThreshold,
          retryPolicy.cooldownDurationMs,
        );

        const isUnsupportedCap = err instanceof InferenceError && err.code === "unsupported_capability";
        const isRetryable = err instanceof InferenceError ? err.retryable : true;
        const canFallback = (isRetryable || isUnsupportedCap) && !opts?.signal?.aborted && i < targets.length - 1;

        if (!canFallback) {
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

let defaultRuntimeInstance: ProviderRuntime | undefined;

/**
 * Returns the default global ProviderRuntime instance for composition root wiring.
 */
export function getDefaultProviderRuntime(): ProviderRuntime {
  if (!defaultRuntimeInstance) {
    defaultRuntimeInstance = new ProviderRuntime();
  }
  return defaultRuntimeInstance;
}

/**
 * Resets the default global ProviderRuntime instance (used in tests).
 */
export function resetDefaultProviderRuntime(): void {
  defaultRuntimeInstance = undefined;
}
