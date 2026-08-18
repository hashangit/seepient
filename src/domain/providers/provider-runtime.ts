import { EventEmitter } from "node:events";
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
import { ModelCatalog, extractUserDeclaredModels } from "./model-catalog.js";
import { CompositeCredentialStore } from "./credentials/composite-credential-store.js";
import {
  type TurnSnapshot,
  type InvocationPlan,
  type Purpose,
  type Tier,
  resolveInvocationPlan,
} from "./assignment-resolver.js";
export type { TurnSnapshot, InvocationPlan };
import {
  type ModelAssignmentOverride,
  DEFAULT_RETRY_POLICY,
} from "../../foundations/schemas/provider-config.js";
import { redactObject } from "./audit-log.js";

import type { InferenceAdapter } from "../../foundations/contracts/backend-ports.js";

export const MAX_RETRY_DURATION_MS = 240_000;

export function calculateInferenceCost(
  usage?: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; reasoningTokens?: number },
  pricing?: any,
): number | undefined {
  if (!usage || !pricing) return undefined;
  const inputPrice = pricing.promptPerMillion ?? pricing.input;
  const outputPrice = pricing.completionPerMillion ?? pricing.output;
  const cachedPrice = pricing.cachedPromptPerMillion ?? pricing.cachedInput;
  const reasoningPrice = pricing.reasoningPerMillion ?? pricing.reasoning;

  if (inputPrice === undefined && outputPrice === undefined) {
    return undefined;
  }

  const inputCost = inputPrice !== undefined ? ((usage.inputTokens ?? 0) * inputPrice) / 1_000_000 : 0;
  const outputCost = outputPrice !== undefined ? ((usage.outputTokens ?? 0) * outputPrice) / 1_000_000 : 0;
  const cachedCost =
    cachedPrice !== undefined && usage.cachedInputTokens
      ? (usage.cachedInputTokens * cachedPrice) / 1_000_000
      : 0;
  const reasoningCost =
    reasoningPrice !== undefined && usage.reasoningTokens
      ? (usage.reasoningTokens * reasoningPrice) / 1_000_000
      : 0;

  return inputCost + outputCost + cachedCost + reasoningCost;
}

export interface ProviderRuntimeOptions {
  configStore?: ProviderConfigStore;
  credentialStore?: CredentialStore;
  modelCatalog?: ModelCatalog;
  adapter?: AggregateInferenceAdapter | InferenceAdapter;
}

export interface CapabilityHealth {
  consecutiveFailures: number;
  cooldownUntil?: number;
}

/**
 * Central ProviderRuntime managing turn snapshots, plan resolution, execution dispatch,
 * and multi-target retries with cooldown tracking and dynamic catalog synchronization.
 */
export class ProviderRuntime extends EventEmitter {
  readonly configStore: ProviderConfigStore;
  readonly credentialStore: CredentialStore;
  readonly modelCatalog: ModelCatalog;
  readonly adapter: AggregateInferenceAdapter | InferenceAdapter;

  private healthMap = new Map<string, CapabilityHealth>();

  constructor(options?: ProviderRuntimeOptions) {
    super();
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

    if (cooldownUntil !== undefined) {
      this.emit("cooldown:engaged", redactObject({
        providerAccount: account,
        capability,
        cooldownUntil,
      }));
    }
  }

  /**
   * Creates an immutable TurnSnapshot pinned for the duration of a conversation turn.
   */
  async createTurnSnapshot(): Promise<TurnSnapshot> {
    const config = await this.configStore.getEffectiveConfig();
    const userDeclared = extractUserDeclaredModels(config);
    const catalog = await this.modelCatalog.getAllModels(userDeclared);

    // Synchronize catalog with aggregate adapter so dynamic models route accurately
    if ("updateCatalog" in this.adapter && typeof (this.adapter as any).updateCatalog === "function") {
      (this.adapter as any).updateCatalog(catalog);
    }

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
    const plan = await resolveInvocationPlan(snapshot, this.credentialStore, purpose, tier, override);
    this.emit("plan:resolved", redactObject({ purpose, tier, plan }));
    return plan;
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
    const startTime = Date.now();

    let lastError: any;

    for (let i = 0; i < targets.length; i++) {
      if (Date.now() - startTime > MAX_RETRY_DURATION_MS) {
        yield {
          type: "error",
          error: {
            code: "timeout",
            message: "Inference retry duration exceeded 240s budget",
            retryable: false,
          },
        };
        return;
      }

      const target = targets[i];
      const health = this.getHealth(target.providerAccount, "language");

      if (health.cooldownUntil && health.cooldownUntil > Date.now() && i < targets.length - 1) {
        // Skip cooled down target if we have another fallback available
        this.emit("inference:fallback", redactObject({
          fromTarget: target,
          toTarget: targets[i + 1],
          reason: "Target in cooldown",
        }));
        continue;
      }

      this.emit("inference:attempt", redactObject({
        target,
        capability: "language",
        attemptIndex: i,
      }));

      let bound: BoundAdapter;
      try {
        bound = await this.adapter.bind(target, plan.snapshot?.catalog);
      } catch (err: any) {
        lastError = err;
        this.recordFailure(
          target.providerAccount,
          "language",
          retryPolicy.cooldownThreshold,
          retryPolicy.cooldownDurationMs,
        );
        this.emit("inference:failure", redactObject({
          target,
          capability: "language",
          error: err.message,
          retryable: err instanceof InferenceError ? err.retryable : true,
        }));
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
        this.emit("inference:failure", redactObject({
          target,
          capability: "language",
          error: lastError.message,
          retryable: false,
        }));
        continue;
      }

      let emittedAnyDelta = false;
      let hadError = false;

      const mergedReq: LanguageRequest = {
        ...req,
        thinkingLevel: req.thinkingLevel ?? target.thinkingLevel,
      };

      try {
        for await (const event of bound.language.stream(mergedReq, opts)) {
          if (event.type === "content_block_delta") {
            emittedAnyDelta = true;
          }
          if (event.type === "finish" && event.usage) {
            const catalogModel = plan.snapshot?.catalog.find(
              (m) =>
                m.id === target.model &&
                (m.upstreamProvider === target.upstreamProvider ||
                  m.upstreamProvider === target.providerAccount),
            );
            const cost = calculateInferenceCost(event.usage, catalogModel?.pricing);
            this.emit("inference:success", redactObject({
              target,
              capability: "language",
              durationMs: Date.now() - startTime,
              usage: event.usage,
              cost,
            }));
          }
          if (event.type === "error") {
            hadError = true;
            this.recordFailure(
              target.providerAccount,
              "language",
              retryPolicy.cooldownThreshold,
              retryPolicy.cooldownDurationMs,
            );
            this.emit("inference:failure", redactObject({
              target,
              capability: "language",
              error: event.error.message,
              retryable: event.error.retryable,
            }));

            if (!emittedAnyDelta && i < targets.length - 1 && event.error.retryable) {
              // Fallback to next candidate if no tokens were emitted yet
              this.emit("inference:fallback", redactObject({
                fromTarget: target,
                toTarget: targets[i + 1],
                reason: event.error.message,
              }));
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
    const op = req.operation ?? "generate";
    const capKey =
      op === "variation"
        ? "imageVariation"
        : op === "edit"
          ? "imageEdit"
          : op === "mask"
            ? "imageMask"
            : "imageGenerate";

    const allTargets = [plan.selectedTarget, ...plan.failureTargets];
    const catalog = plan.snapshot?.catalog || [];

    // Filter targets that support the requested operation
    const targets = allTargets.filter((t) => {
      const cm = catalog.find(
        (m) =>
          m.id === t.model &&
          (m.upstreamProvider === t.upstreamProvider || m.upstreamProvider === t.providerAccount),
      );
      if (!cm) return true;
      return (cm.capabilities as any)[capKey] !== false;
    });

    if (targets.length === 0) {
      throw new InferenceError({
        code: "unsupported_capability",
        message: `No configured target supports image operation "${op}" for target ${plan.selectedTarget.providerAccount}:${plan.selectedTarget.model}`,
        providerAccount: plan.selectedTarget.providerAccount,
        model: plan.selectedTarget.model,
        retryable: false,
      });
    }

    const retryPolicy = plan.snapshot?.config?.retryPolicy ?? DEFAULT_RETRY_POLICY;
    const startTime = Date.now();
    let lastError: any;

    for (let i = 0; i < targets.length; i++) {
      if (Date.now() - startTime > MAX_RETRY_DURATION_MS) {
        throw new InferenceError({
          code: "timeout",
          message: "Image retry duration exceeded 240s budget",
          retryable: false,
        });
      }

      const target = targets[i];

      const health = this.getHealth(target.providerAccount, "image");
      if (health.cooldownUntil && health.cooldownUntil > Date.now() && i < targets.length - 1) {
        this.emit("inference:fallback", redactObject({
          fromTarget: target,
          toTarget: targets[i + 1],
          reason: "Target in cooldown",
        }));
        continue;
      }

      this.emit("inference:attempt", redactObject({
        target,
        capability: "image",
        attemptIndex: i,
      }));

      try {
        const bound = await this.adapter.bind(target, plan.snapshot?.catalog);
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
        this.emit("inference:success", redactObject({
          target,
          capability: "image",
          durationMs: Date.now() - startTime,
        }));
        return result;
      } catch (err: any) {
        lastError = err;
        this.recordFailure(
          target.providerAccount,
          "image",
          retryPolicy.cooldownThreshold,
          retryPolicy.cooldownDurationMs,
        );
        this.emit("inference:failure", redactObject({
          target,
          capability: "image",
          error: err.message,
          retryable: err instanceof InferenceError ? err.retryable : true,
        }));

        const isUnsupportedCap =
          err instanceof InferenceError && err.code === "unsupported_capability";
        const isRetryable = err instanceof InferenceError ? err.retryable : true;
        const canFallback =
          (isRetryable || isUnsupportedCap) && !opts?.signal?.aborted && i < targets.length - 1;

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

  /**
   * Updates the provider configuration overlay with optimistic concurrency control.
   */
  async updateOverlay(
    patch: import("../../foundations/schemas/provider-config.js").ProviderLayerPatch,
    expectedRevision: number,
  ): Promise<import("../../foundations/schemas/provider-config.js").OverlayDocument> {
    return this.configStore.updateOverlay(patch, expectedRevision);
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
