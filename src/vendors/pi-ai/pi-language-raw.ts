import { builtinModels } from "@earendil-works/pi-ai/providers/all";
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
  return {
    promptTokens: piUsage.input ?? 0,
    completionTokens: piUsage.output ?? 0,
    totalTokens: piUsage.totalTokens ?? ((piUsage.input ?? 0) + (piUsage.output ?? 0)),
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

/**
 * Pi AI raw language backend implementation.
 */
export class PiLanguageRaw implements LanguageBackend {
  private models: Models;

  constructor(customModels?: Models) {
    this.models = customModels ?? builtinModels();
  }

  private prepareInvocation(
    target: InferenceTarget,
    req: LanguageRequest,
    apiKey?: string,
    signal?: AbortSignal,
    opts?: InferenceOptions,
  ) {
    const knownPiProviders = new Set([
      "openai",
      "anthropic",
      "google",
      "openrouter",
      "zai",
      "groq",
      "mistral",
      "cerebras",
      "together",
      "deepseek",
      "bedrock",
    ]);

    const providerName = target.upstreamProvider === "glm" ? "zai" : target.upstreamProvider;
    const isKnown = knownPiProviders.has(providerName);
    const piProvider = isKnown ? providerName : "openai";

    if (!isKnown && !target.baseUrl) {
      throw new InferenceError({
        code: "invalid_request",
        message: `Custom or unknown upstream provider "${target.upstreamProvider}" requires a baseUrl`,
        providerAccount: target.providerAccount,
        model: target.model,
        retryable: false,
      });
    }

    let model = this.models.getModel(piProvider, target.model) as Model<Api> | undefined;

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
        reasoning: Boolean(target.thinkingLevel && target.thinkingLevel !== "none"),
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
      const apiKey = secret.kind === "api_key" ? secret.value : undefined;

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

      try {
        const stream =
          req.thinkingLevel && req.thinkingLevel !== "none"
            ? this.models.streamSimple(model, context as any, {
                ...streamOptions,
                reasoning: req.thinkingLevel as any,
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
              yield {
                type: "content_block_stop",
                index: event.contentIndex,
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
            if (event.reason === "aborted") {
              yield {
                type: "abort",
                reason: isTimeout() ? "timeout" : "user",
                partialUsage: lastUsage,
              };
              return;
            }
            const classified = classifyPiError(event.error?.errorMessage || "", isTimeout());
            yield {
              type: "error",
              error: {
                code: classified.code,
                message: event.error?.errorMessage || "Pi inference error",
                retryable: classified.retryable,
              },
              partialUsage: lastUsage,
            };
            return;
          }
        }

        for (const idx of openBlocks) {
          yield { type: "content_block_stop", index: idx };
        }

        yield {
          type: "finish",
          stopReason: lastStopReason,
          usage: lastUsage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        };
      } catch (err: any) {
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
            };
          }
          return;
        }

        const classified = classifyPiError(err?.message || "", isTimeout());
        yield {
          type: "error",
          error: {
            code: classified.code,
            message: err?.message || "Pi language stream failed",
            retryable: classified.retryable,
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
      const apiKey = secret.kind === "api_key" ? secret.value : undefined;

      const { model, context, streamOptions } = this.prepareInvocation(
        target,
        req,
        apiKey,
        signal,
        opts,
      );

      const stream =
        req.thinkingLevel && req.thinkingLevel !== "none"
          ? this.models.streamSimple(model, context as any, {
              ...streamOptions,
              reasoning: req.thinkingLevel as any,
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
          const classified = classifyPiError(event.error?.errorMessage || "", timeout);
          throw new InferenceError({
            code: event.reason === "aborted" ? "timeout" : (classified.code as any),
            message: event.error?.errorMessage || "Pi chat request failed",
            providerAccount: target.providerAccount,
            model: target.model,
            retryable: event.reason === "aborted" ? true : classified.retryable,
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
    } finally {
      cleanup();
      await lease.release();
    }
  }
}

function classifyPiError(msg: string, isTimeout: boolean): { code: string; retryable: boolean } {
  if (isTimeout) return { code: "timeout", retryable: true };
  const lower = (msg || "").toLowerCase();
  if (
    lower.includes("401") ||
    lower.includes("unauthorized") ||
    lower.includes("invalid api key") ||
    lower.includes("invalid_api_key") ||
    lower.includes("403") ||
    lower.includes("forbidden")
  ) {
    return { code: "auth", retryable: false };
  }
  if (
    lower.includes("429") ||
    lower.includes("rate limit") ||
    lower.includes("rate_limit") ||
    lower.includes("quota")
  ) {
    return { code: "rate_limit", retryable: true };
  }
  if (
    lower.includes("model not found") ||
    lower.includes("does not exist") ||
    lower.includes("404")
  ) {
    return { code: "model_not_found", retryable: false };
  }
  if (
    lower.includes("context length") ||
    lower.includes("maximum context") ||
    lower.includes("context_length_exceeded")
  ) {
    return { code: "context_overflow", retryable: false };
  }
  return { code: "network", retryable: true };
}
