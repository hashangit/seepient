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
  canonicalToPiMessages,
  canonicalToPiTools,
} from "./pi-canonical-converter.js";

type AssistantContentBlock = TextBlock | ReasoningBlock | ToolUseBlock;

/** Combine AbortSignal and timeoutMs into a single effective AbortSignal */
function resolveSignal(opts?: InferenceOptions): { signal?: AbortSignal; cleanup: () => void } {
  if (!opts?.timeoutMs && !opts?.signal) {
    return { signal: undefined, cleanup: () => {} };
  }

  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;

  if (opts.timeoutMs && opts.timeoutMs > 0) {
    timer = setTimeout(() => {
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
    reasoningTokens: piUsage.reasoning,
    cost: piUsage.cost?.total,
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

  async *chatStream(
    target: InferenceTarget,
    req: LanguageRequest,
    opts?: InferenceOptions,
  ): AsyncIterable<StreamEvent> {
    const lease = target.credential.acquireLease();
    const { signal, cleanup } = resolveSignal(opts);

    try {
      if (signal?.aborted) {
        yield {
          type: "abort",
          reason: "timeout",
        };
        return;
      }

      const secret = await lease.secret();
      const apiKey = secret.kind === "api_key" ? secret.value : undefined;

      const providerName = target.upstreamProvider === "glm" ? "zai" : target.upstreamProvider;
      let model = this.models.getModel(providerName, target.model) as Model<Api> | undefined;

      if (!model) {
        model = {
          id: target.model,
          provider: providerName,
          name: target.model,
          api: providerName === "anthropic" ? "anthropic-messages" : "openai-completions",
          baseUrl: target.baseUrl,
          contextWindow: 128_000,
          maxOutputTokens: req.maxOutputTokens ?? 4096,
        } as any;
      }
      const resolvedModel: Model<Api> = model!;

      const piMessages = canonicalToPiMessages(req.messages);
      const piTools = canonicalToPiTools(req.tools);

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
      let lastResponseId: string | undefined;

      const streamOptions: any = {
        signal,
        apiKey,
        maxTokens: req.maxOutputTokens,
      };

      const context = {
        messages: piMessages,
        tools: piTools.length > 0 ? piTools : undefined,
      };

      try {
        const stream =
          req.thinkingLevel && req.thinkingLevel !== "none"
            ? this.models.streamSimple(resolvedModel, context as any, {
                ...streamOptions,
                reasoning: req.thinkingLevel as any,
              })
            : this.models.stream(resolvedModel, context as any, streamOptions);

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
            yield {
              type: "content_block_start",
              index: event.contentIndex,
              block: { type: "reasoning", text: "" },
            };
          } else if (event.type === "thinking_delta") {
            if (!openBlocks.has(event.contentIndex)) {
              openBlocks.add(event.contentIndex);
              yield {
                type: "content_block_start",
                index: event.contentIndex,
                block: { type: "reasoning", text: "" },
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
            yield {
              type: "content_block_start",
              index: event.contentIndex,
              block: {
                type: "tool_use",
                id: `call_${event.contentIndex}`,
                name: "",
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
            lastResponseId = event.message?.responseId;
          } else if (event.type === "error") {
            if (event.reason === "aborted") {
              yield {
                type: "abort",
                reason: signal?.aborted ? "timeout" : "user",
                partialUsage: lastUsage,
              };
              return;
            }
            yield {
              type: "error",
              error: {
                code: "internal_adapter",
                message: event.error?.errorMessage || "Pi inference error",
                retryable: true,
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
        const isTimeout = signal?.aborted;
        yield {
          type: "error",
          error: {
            code: isTimeout ? "timeout" : "network",
            message: err?.message || "Pi language stream failed",
            retryable: true,
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
    const { signal, cleanup } = resolveSignal(opts);

    try {
      if (signal?.aborted) {
        throw new InferenceError({
          code: "timeout",
          message: signal.reason?.message || "Operation aborted",
          providerAccount: target.providerAccount,
          model: target.model,
          retryable: false,
        });
      }

      const secret = await lease.secret();
      const apiKey = secret.kind === "api_key" ? secret.value : undefined;

      const providerName = target.upstreamProvider === "glm" ? "zai" : target.upstreamProvider;
      let model = this.models.getModel(providerName, target.model) as Model<Api> | undefined;

      if (!model) {
        model = {
          id: target.model,
          provider: providerName,
          name: target.model,
          api: providerName === "anthropic" ? "anthropic-messages" : "openai-completions",
          baseUrl: target.baseUrl,
          contextWindow: 128_000,
          maxOutputTokens: req.maxOutputTokens ?? 4096,
        } as any;
      }
      const resolvedModel: Model<Api> = model!;

      const piMessages = canonicalToPiMessages(req.messages);
      const piTools = canonicalToPiTools(req.tools);

      const streamOptions: any = {
        signal,
        apiKey,
        maxTokens: req.maxOutputTokens,
      };

      const context = {
        messages: piMessages,
        tools: piTools.length > 0 ? piTools : undefined,
      };

      const stream =
        req.thinkingLevel && req.thinkingLevel !== "none"
          ? this.models.streamSimple(resolvedModel, context as any, {
              ...streamOptions,
              reasoning: req.thinkingLevel as any,
            })
          : this.models.stream(resolvedModel, context as any, streamOptions);

      let finalMessage: AssistantMessage | undefined;
      let finalReason: string = "stop";

      for await (const event of stream) {
        if (event.type === "done") {
          finalMessage = event.message;
          finalReason = event.reason;
        } else if (event.type === "error") {
          throw new InferenceError({
            code: event.reason === "aborted" ? "timeout" : "network",
            message: event.error?.errorMessage || "Pi chat request failed",
            providerAccount: target.providerAccount,
            model: target.model,
            retryable: event.reason !== "aborted",
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
              providerApi: resolvedModel.api,
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
