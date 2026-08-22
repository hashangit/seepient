import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { createPiCredentialStore } from "./pi-auth-adapter.js";
import type {
  Models,
  Model,
  Api,
  AssistantMessage,
  AssistantMessageEvent,
} from "@earendil-works/pi-ai";
import type {
  LanguageBackend,
  InferenceTarget,
  LanguageRequest,
  InferenceOptions,
} from "../../foundations/contracts/backend-ports.js";
import type {
  StreamEvent,
  InferenceResponse,
  Usage,
  StopReason,
  TextBlock,
  ReasoningBlock,
  ToolUseBlock,
} from "../../foundations/schemas/inference.js";
import { InferenceError } from "../../foundations/errors.js";
import { classifyInferenceError } from "../../foundations/errors/error-classifier.js";
import {
  canonicalToPiContext,
  canonicalToPiMessages,
  canonicalToPiTools,
} from "./pi-canonical-converter.js";

type AssistantContentBlock = TextBlock | ReasoningBlock | ToolUseBlock;

interface ResolvedSignalInfo {
  signal?: AbortSignal;
  isTimeout: () => boolean;
  cleanup: () => void;
}

/** Combine AbortSignal and timeoutMs with explicit timeout tracking */
function resolveSignal(opts?: InferenceOptions): ResolvedSignalInfo {
  if (!opts?.timeoutMs && !opts?.signal) {
    return { signal: undefined, isTimeout: () => false, cleanup: () => {} };
  }

  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let didTimeout = false;

  if (opts.timeoutMs && opts.timeoutMs > 0) {
    timer = setTimeout(() => {
      didTimeout = true;
      controller.abort(new Error(`Operation timed out after ${opts.timeoutMs}ms`));
    }, opts.timeoutMs);
  }

  const onAbort = () => controller.abort(opts.signal?.reason);
  if (opts.signal) {
    if (opts.signal.aborted) {
      controller.abort(opts.signal.reason);
    } else {
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  return {
    signal: controller.signal,
    isTimeout: () => didTimeout,
    cleanup: () => {
      if (timer) clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
    },
  };
}

function mapPiUsageToCanonical(piUsage?: any): Usage | undefined {
  if (!piUsage) return undefined;
  const input = piUsage.input ?? piUsage.promptTokens ?? 0;
  const output = piUsage.output ?? piUsage.completionTokens ?? 0;
  const total = piUsage.totalTokens ?? (input + output);
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: total,
    promptTokens: input,
    completionTokens: output,
    cachedPromptTokens: piUsage.cacheRead ?? undefined,
    reasoningTokens: piUsage.reasoning ?? undefined,
    cost: piUsage.cost?.total ?? undefined,
  };
}

function mapPiStopReasonToCanonical(reason?: string): StopReason {
  if (reason === "toolUse") return "tool_use";
  if (reason === "length") return "max_tokens";
  return "end_turn";
}

async function resolveSecretApiKey(
  secret: any,
  target: InferenceTarget,
  credentialStore?: any,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (!secret) return undefined;
  if (secret.kind === "api_key") {
    return secret.value;
  }
  if (secret.kind === "pi_oauth" || secret.kind === "oauth") {
    const rawCtx = secret.piAuthContext ?? secret;
    let access = rawCtx.access;
    const refresh = rawCtx.refresh;
    const expires = rawCtx.expires;

    const isExpired =
      typeof expires === "number"
        ? expires === 0 || Date.now() >= expires - 60_000
        : Boolean(refresh);

    // Check if token is expired or close to expiry (within 60 seconds)
    if (isExpired && refresh) {
      try {
        const { getOAuthFlow, createPiCredentialStore } = await import("./pi-auth-adapter.js");
        const flow = await getOAuthFlow(target.upstreamProvider);
        if (flow && typeof (flow as any).refresh === "function") {
          const oauthCred = {
            type: "oauth" as const,
            access: access ?? "",
            refresh,
            expires: expires ?? 0,
          };
          const store = credentialStore ?? (target.credential as any)?.store;
          if (store && (typeof store.modify === "function" || typeof store.put === "function")) {
            const piStore = createPiCredentialStore(store);
            const modified = await piStore.modify(target.providerAccount, async (curr) => {
              if (
                curr &&
                curr.type === "oauth" &&
                curr.access &&
                typeof curr.expires === "number" &&
                curr.expires > 0 &&
                Date.now() < curr.expires - 60_000
              ) {
                return curr;
              }
              const base = curr && curr.type === "oauth" ? curr : oauthCred;
              const refreshed = await (flow as any).refresh(base, signal);
              if (!refreshed?.access) {
                throw new Error("OAuth token refresh returned empty access token");
              }
              return refreshed;
            });
            if (modified && modified.type === "oauth") {
              access = modified.access;
            }
          } else {
            const refreshed = await (flow as any).refresh(oauthCred, signal);
            if (refreshed?.access) {
              access = refreshed.access;
            } else {
              throw new Error("OAuth token refresh returned empty access token");
            }
          }
        }
      } catch (err: any) {
        throw new InferenceError({
          code: "oauth_expired",
          message: `OAuth session for "${target.providerAccount}" expired — sign in again (/login ${target.upstreamProvider}): ${err?.message ?? "refresh failed"}`,
          providerAccount: target.providerAccount,
          model: target.model,
          retryable: false,
        });
      }
    }

    if (!access) {
      throw new InferenceError({
        code: "oauth_expired",
        message: `OAuth session for "${target.providerAccount}" expired or has no access token — sign in again (/login ${target.upstreamProvider})`,
        providerAccount: target.providerAccount,
        model: target.model,
        retryable: false,
      });
    }

    return access;
  }
  return undefined;
}

/**
 * Pi AI raw language backend implementation.
 */
export class PiLanguageRaw implements LanguageBackend {
  private models: Models;
  private credentialStore?: any;

  constructor(customModels?: Models, credentialStore?: any) {
    this.credentialStore = credentialStore;
    if (customModels) {
      this.models = customModels;
    } else {
      const piStore = credentialStore ? createPiCredentialStore(credentialStore) : undefined;
      this.models = builtinModels(piStore ? { credentials: piStore } : undefined);
    }
  }

  private prepareInvocation(
    target: InferenceTarget,
    req: LanguageRequest,
    apiKey?: string,
    signal?: AbortSignal,
    opts?: InferenceOptions,
  ) {
    const providerName = target.upstreamProvider === "glm" ? "zai" : target.upstreamProvider;
    let model = this.models.getModel(providerName, target.model) as Model<Api> | undefined;

    const isKnown =
      Boolean(model) ||
      (typeof this.models.getProviders === "function" &&
        this.models.getProviders().some((p) => p.id === providerName));
    const piProvider = model ? (model.provider || providerName) : (isKnown ? providerName : "openai");

    if (!isKnown && !target.baseUrl) {
      throw new InferenceError({
        code: "invalid_request",
        message: `Custom or unknown upstream provider "${target.upstreamProvider}" requires a baseUrl`,
        providerAccount: target.providerAccount,
        model: target.model,
        retryable: false,
      });
    }

    const effectiveThinking = req.thinkingLevel ?? target.thinkingLevel;
    const isThinking = Boolean(effectiveThinking && effectiveThinking !== "none");

    if (model) {
      if (target.baseUrl) {
        model = { ...model, baseUrl: target.baseUrl };
      }
    } else {
      const api: Api = providerName === "anthropic" ? "anthropic-messages" : "openai-completions";
      model = {
        id: target.model,
        provider: piProvider as any,
        name: target.model,
        api,
        baseUrl:
          target.baseUrl ||
          (providerName === "anthropic"
            ? "https://api.anthropic.com"
            : "https://api.openai.com/v1"),
        reasoning: isThinking,
        input: ["text", "image"],
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          tiers: [],
        },
        contextWindow: 128_000,
        maxTokens: req.maxOutputTokens ?? 4096,
        compat: target.compat as any,
      };
    }

    const converted = canonicalToPiContext(req.messages, {
      api: model?.api,
      provider: piProvider,
      model: target.model,
    });
    const piTools = canonicalToPiTools(req.tools);

    const streamOptions: any = {
      signal,
      apiKey,
      maxTokens: req.maxOutputTokens,
      timeoutMs: opts?.timeoutMs,
    };

    const context = {
      systemPrompt: converted.systemPrompt,
      messages: converted.messages,
      tools: piTools.length > 0 ? piTools : undefined,
    };

    return {
      model: model!,
      context,
      streamOptions,
    };
  }

  async *chatStream(
    target: InferenceTarget,
    req: LanguageRequest,
    opts?: InferenceOptions,
  ): AsyncIterable<StreamEvent> {
    const lease = target.credential.acquireLease();
    const { signal, isTimeout, cleanup } = resolveSignal(opts);

    try {
      if (signal?.aborted) {
        yield {
          type: "abort",
          reason: isTimeout() ? "timeout" : "user",
        };
        return;
      }

      const secret = await lease.secret();
      const apiKey = await resolveSecretApiKey(secret, target, this.credentialStore, signal);

      const { model, context, streamOptions } = this.prepareInvocation(
        target,
        req,
        apiKey,
        signal,
        opts,
      );

      yield {
        type: "start",
        resolvedModel: {
          modelId: target.model,
          providerAccount: target.providerAccount,
        },
      };

      const openBlocks = new Set<number>();
      let lastUsage: Usage | undefined;
      let lastStopReason: StopReason = "end_turn";

      const effectiveThinking = req.thinkingLevel ?? target.thinkingLevel;
      const isThinking = Boolean(effectiveThinking && effectiveThinking !== "none");

      try {
        const stream = isThinking
          ? this.models.streamSimple(model, context as any, {
              ...streamOptions,
              reasoning: effectiveThinking as any,
            })
          : this.models.stream(model, context as any, streamOptions);

        for await (const event of stream) {
          if (event.type === "text_start") {
            openBlocks.add(event.contentIndex);
            yield {
              type: "content_block_start",
              index: event.contentIndex,
              block: { type: "text", text: "" },
            };
          } else if (event.type === "text_delta") {
            if (!openBlocks.has(event.contentIndex)) {
              openBlocks.add(event.contentIndex);
              yield {
                type: "content_block_start",
                index: event.contentIndex,
                block: { type: "text", text: "" },
              };
            }
            yield {
              type: "content_block_delta",
              index: event.contentIndex,
              delta: { type: "text_delta", text: event.delta },
            };
          } else if (event.type === "text_end") {
            if (openBlocks.has(event.contentIndex)) {
              openBlocks.delete(event.contentIndex);
              yield {
                type: "content_block_stop",
                index: event.contentIndex,
              };
            }
          } else if (event.type === "thinking_start") {
            openBlocks.add(event.contentIndex);
            const sig = (event as any).signature || (event.partial?.content as any)?.[event.contentIndex]?.thinkingSignature;
            yield {
              type: "content_block_start",
              index: event.contentIndex,
              block: {
                type: "reasoning",
                text: "",
                signature: sig,
                signatureProvenance: sig ? {
                  adapter: "pi-ai",
                  providerApi: model.api,
                  upstreamProvider: target.upstreamProvider,
                } : undefined,
              },
            };
          } else if (event.type === "thinking_delta") {
            if (!openBlocks.has(event.contentIndex)) {
              openBlocks.add(event.contentIndex);
              const sig = (event as any).signature || (event.partial?.content as any)?.[event.contentIndex]?.thinkingSignature;
              yield {
                type: "content_block_start",
                index: event.contentIndex,
                block: {
                  type: "reasoning",
                  text: "",
                  signature: sig,
                  signatureProvenance: sig ? {
                    adapter: "pi-ai",
                    providerApi: model.api,
                    upstreamProvider: target.upstreamProvider,
                  } : undefined,
                },
              };
            }
            yield {
              type: "content_block_delta",
              index: event.contentIndex,
              delta: { type: "reasoning_delta", text: event.delta },
            };
          } else if (event.type === "thinking_end") {
            if (openBlocks.has(event.contentIndex)) {
              openBlocks.delete(event.contentIndex);
              const sig =
                (event as any).signature ||
                (event.partial?.content as any)?.[event.contentIndex]?.thinkingSignature;
              yield {
                type: "content_block_stop",
                index: event.contentIndex,
                signature: sig,
                signatureProvenance: sig
                  ? {
                      adapter: "pi-ai",
                      providerApi: model.api,
                      upstreamProvider: target.upstreamProvider,
                    }
                  : undefined,
              };
            }
          } else if (event.type === "toolcall_start") {
            openBlocks.add(event.contentIndex);
            // Pi populates partial.content[event.contentIndex] with { type: 'toolCall', id, name, arguments: {} }
            const partialItem = (event.partial?.content as any)?.[event.contentIndex];
            const toolId = partialItem?.id || `call_${event.contentIndex}`;
            const toolName = partialItem?.name || "";

            yield {
              type: "content_block_start",
              index: event.contentIndex,
              block: {
                type: "tool_use",
                id: toolId,
                name: toolName,
                input: {},
              },
            };
          } else if (event.type === "toolcall_delta") {
            yield {
              type: "content_block_delta",
              index: event.contentIndex,
              delta: {
                type: "tool_input_delta",
                partialJson: event.delta,
              },
            };
          } else if (event.type === "toolcall_end") {
            if (openBlocks.has(event.contentIndex)) {
              openBlocks.delete(event.contentIndex);
              yield {
                type: "content_block_stop",
                index: event.contentIndex,
              };
            }
          } else if (event.type === "done") {
            lastStopReason = mapPiStopReasonToCanonical(event.reason);
            lastUsage = mapPiUsageToCanonical(event.message?.usage);
          } else if (event.type === "error") {
            if (event.error?.usage) {
              lastUsage = mapPiUsageToCanonical(event.error.usage);
            }

            // Drain open blocks before yielding abort/error (B-11)
            for (const idx of openBlocks) {
              yield { type: "content_block_stop", index: idx };
            }
            openBlocks.clear();

            if (event.reason === "aborted") {
              yield {
                type: "abort",
                reason: isTimeout() ? "timeout" : "user",
                partialUsage: lastUsage,
              };
              return;
            }
            const classified = classifyInferenceError(event.error?.errorMessage || "", isTimeout());
            yield {
              type: "error",
              error: {
                code: classified.code,
                message: event.error?.errorMessage || "Pi inference error",
                retryable: classified.retryable,
                retryAfterMs: classified.retryAfterMs,
              },
              partialUsage: lastUsage,
            };
            return;
          }
        }

        for (const idx of openBlocks) {
          yield { type: "content_block_stop", index: idx };
        }
        openBlocks.clear();

        yield {
          type: "finish",
          stopReason: lastStopReason,
          usage: lastUsage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        };
      } catch (err: any) {
        for (const idx of openBlocks) {
          yield { type: "content_block_stop", index: idx };
        }
        openBlocks.clear();

        if (signal?.aborted) {
          const timeout = isTimeout();
          if (timeout) {
            yield {
              type: "error",
              error: {
                code: "timeout",
                message: err?.message || "Pi language stream timed out",
                retryable: true,
              },
              partialUsage: lastUsage,
            };
          } else {
            yield {
              type: "abort",
              reason: "user",
              partialUsage: lastUsage,
            };
          }
          return;
        }

        const classified = classifyInferenceError(err?.message || "", isTimeout());
        yield {
          type: "error",
          error: {
            code: classified.code,
            message: err?.message || "Pi language stream failed",
            retryable: classified.retryable,
            retryAfterMs: classified.retryAfterMs,
          },
          partialUsage: lastUsage,
        };
      }
    } finally {
      cleanup();
      await lease.release();
    }
  }

  async chat(
    target: InferenceTarget,
    req: LanguageRequest,
    opts?: InferenceOptions,
  ): Promise<InferenceResponse> {
    const lease = target.credential.acquireLease();
    const { signal, cleanup, isTimeout } = resolveSignal(opts);

    try {
      if (signal?.aborted) {
        const timeout = isTimeout();
        throw new InferenceError({
          code: timeout ? "timeout" : "invalid_request",
          message: signal.reason?.message || (timeout ? "Request timed out" : "Operation aborted"),
          providerAccount: target.providerAccount,
          model: target.model,
          retryable: timeout,
        });
      }

      const secret = await lease.secret();
      const apiKey = await resolveSecretApiKey(secret, target, this.credentialStore, signal);

      const { model, context, streamOptions } = this.prepareInvocation(
        target,
        req,
        apiKey,
        signal,
        opts,
      );

      const effectiveThinking = req.thinkingLevel ?? target.thinkingLevel;
      const isThinking = Boolean(effectiveThinking && effectiveThinking !== "none");

      const stream = isThinking
        ? this.models.streamSimple(model, context as any, {
            ...streamOptions,
            reasoning: effectiveThinking as any,
          })
        : this.models.stream(model, context as any, streamOptions);

      let finalMessage: AssistantMessage | undefined;
      let finalReason: string = "stop";

      for await (const event of stream) {
        if (event.type === "done") {
          finalMessage = event.message;
          finalReason = event.reason;
        } else if (event.type === "error") {
          const timeout = isTimeout();
          const classified = classifyInferenceError(event.error?.errorMessage || "", timeout);
          throw new InferenceError({
            code: event.reason === "aborted" ? "timeout" : (classified.code as any),
            message: event.error?.errorMessage || "Pi chat request failed",
            providerAccount: target.providerAccount,
            model: target.model,
            retryable: event.reason === "aborted" ? true : classified.retryable,
            retryAfterMs: classified.retryAfterMs,
          });
        }
      }

      if (!finalMessage) {
        throw new InferenceError({
          code: "malformed_response",
          message: "Pi stream completed without emitting a final done message",
          providerAccount: target.providerAccount,
          model: target.model,
          retryable: false,
        });
      }

      // Convert authoritative AssistantMessage content into canonical ContentBlocks
      const contentBlocks: AssistantContentBlock[] = [];
      for (const item of finalMessage.content || []) {
        if (item.type === "text") {
          contentBlocks.push({ type: "text", text: item.text });
        } else if (item.type === "thinking") {
          contentBlocks.push({
            type: "reasoning",
            text: item.thinking,
            signature: item.thinkingSignature,
            signatureProvenance: {
              adapter: "pi-ai",
              providerApi: model.api,
              upstreamProvider: target.upstreamProvider,
            },
          });
        } else if (item.type === "toolCall") {
          contentBlocks.push({
            type: "tool_use",
            id: item.id,
            name: item.name,
            input: item.arguments ?? {},
          });
        }
      }

      const stopReason = mapPiStopReasonToCanonical(finalReason);
      const usage = mapPiUsageToCanonical(finalMessage.usage) ?? {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      };

      return {
        message: {
          role: "assistant",
          content: contentBlocks.length > 0 ? contentBlocks : [{ type: "text", text: "" }],
        },
        stopReason,
        usage,
        providerResponseId: finalMessage.responseId,
      };
    } catch (err: any) {
      if (err instanceof InferenceError) {
        throw err;
      }
      if (signal?.aborted) {
        const timeout = isTimeout();
        throw new InferenceError({
          code: timeout ? "timeout" : "invalid_request",
          message: err?.message || (timeout ? "Pi chat request timed out" : "Operation aborted"),
          providerAccount: target.providerAccount,
          model: target.model,
          retryable: timeout,
          cause: err,
        });
      }
      const classified = classifyInferenceError(err?.message || "", isTimeout());
      throw new InferenceError({
        code: classified.code as any,
        message: err?.message || "Pi chat request failed",
        providerAccount: target.providerAccount,
        model: target.model,
        retryable: classified.retryable,
        retryAfterMs: classified.retryAfterMs,
        cause: err,
      });
    } finally {
      cleanup();
      await lease.release();
    }
  }
}
