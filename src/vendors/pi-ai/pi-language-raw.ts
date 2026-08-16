import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { Models, Model, Api } from "@earendil-works/pi-ai";
import type {
  LanguageBackend,
  InferenceTarget,
  LanguageRequest,
  InferenceOptions,
} from "../../foundations/contracts/backend-ports.js";
import type {
  StreamEvent,
  InferenceResponse,
  ContentBlock,
  Usage,
} from "../../foundations/schemas/inference.js";
import { InferenceError } from "../../foundations/errors.js";
import {
  canonicalToPiMessages,
  canonicalToPiTools,
} from "./pi-canonical-converter.js";

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
          type: "error",
          error: {
            code: "timeout",
            message: signal.reason?.message || "Operation aborted",
            retryable: false,
          },
        };
        return;
      }

      const secret = await lease.secret();
      const apiKey = secret.kind === "api_key" ? secret.value : undefined;

      const providerName = target.upstreamProvider === "glm" ? "zai" : target.upstreamProvider;
      let model = this.models.getModel(providerName, target.model) as Model<Api> | undefined;

      if (!model) {
        // Fall back to creating a dynamic model entry if not in static catalog
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

      const piMessages = canonicalToPiMessages(req.messages);
      const piTools = canonicalToPiTools(req.tools);

      yield {
        type: "start",
        resolvedModel: {
          modelId: target.model,
          providerAccount: target.providerAccount,
        },
      };

      let blockIndex = 0;
      let textBlockOpen = false;
      let thinkingBlockOpen = false;
      let accumulatedUsage: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
      let stopReason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" = "end_turn";

      const piOptions: any = {
        signal,
        apiKey,
        reasoning: req.thinkingLevel && req.thinkingLevel !== "none" ? req.thinkingLevel : undefined,
        maxTokens: req.maxOutputTokens,
      };

      try {
        const stream = this.models.stream(
          model!,
          {
            messages: piMessages as any,
            tools: piTools.length > 0 ? piTools : undefined,
          } as any,
          piOptions,
        );

        for await (const event of stream) {
          if (event.type === "text_start") {
            textBlockOpen = true;
            yield {
              type: "content_block_start",
              index: blockIndex,
              block: { type: "text", text: "" },
            };
          } else if (event.type === "text_delta" && (event as any).content) {
            if (!textBlockOpen) {
              textBlockOpen = true;
              yield {
                type: "content_block_start",
                index: blockIndex,
                block: { type: "text", text: "" },
              };
            }
            yield {
              type: "content_block_delta",
              index: blockIndex,
              delta: { type: "text_delta", text: (event as any).content },
            };
          } else if (event.type === "text_end") {
            if (textBlockOpen) {
              textBlockOpen = false;
              yield {
                type: "content_block_stop",
                index: blockIndex,
              };
              blockIndex++;
            }
          } else if (event.type === "thinking_start") {
            thinkingBlockOpen = true;
            yield {
              type: "content_block_start",
              index: blockIndex,
              block: { type: "reasoning", text: "" },
            };
          } else if (event.type === "thinking_delta" && (event as any).content) {
            if (!thinkingBlockOpen) {
              thinkingBlockOpen = true;
              yield {
                type: "content_block_start",
                index: blockIndex,
                block: { type: "reasoning", text: "" },
              };
            }
            yield {
              type: "content_block_delta",
              index: blockIndex,
              delta: { type: "reasoning_delta", text: (event as any).content },
            };
          } else if (event.type === "thinking_end") {
            if (thinkingBlockOpen) {
              thinkingBlockOpen = false;
              yield {
                type: "content_block_stop",
                index: blockIndex,
              };
              blockIndex++;
            }
          } else if ((event as any).type === "toolcall_start" || (event as any).type === "tool_call_start") {
            const toolCall = (event as any).toolCall || event;
            yield {
              type: "content_block_start",
              index: blockIndex,
              block: {
                type: "tool_use",
                id: toolCall.id || `call_${blockIndex}`,
                name: toolCall.name || "",
                input: {},
              },
            };
          } else if ((event as any).type === "toolcall_delta" || (event as any).type === "tool_call_delta") {
            yield {
              type: "content_block_delta",
              index: blockIndex,
              delta: {
                type: "tool_input_delta",
                partialJson: (event as any).delta || (event as any).argumentsDelta || "",
              },
            };
          } else if ((event as any).type === "toolcall_end" || (event as any).type === "tool_call_end") {
            yield {
              type: "content_block_stop",
              index: blockIndex,
            };
            blockIndex++;
            stopReason = "tool_use";
          } else if (event.type === "done") {
            const msg = (event as any).message;
            if (msg?.usage) {
              accumulatedUsage = {
                promptTokens: msg.usage.promptTokens ?? msg.usage.inputTokens ?? 0,
                completionTokens: msg.usage.completionTokens ?? msg.usage.outputTokens ?? 0,
                totalTokens:
                  (msg.usage.promptTokens ?? msg.usage.inputTokens ?? 0) +
                  (msg.usage.completionTokens ?? msg.usage.outputTokens ?? 0),
              };
            }
            if ((event as any).reason === "toolUse") {
              stopReason = "tool_use";
            }
          } else if (event.type === "error") {
            throw new InferenceError({
              code: "internal_adapter",
              message: (event as any).error?.message || "Pi stream error",
              providerAccount: target.providerAccount,
              model: target.model,
              retryable: true,
            });
          }
        }

        if (textBlockOpen) {
          yield { type: "content_block_stop", index: blockIndex };
        }
        if (thinkingBlockOpen) {
          yield { type: "content_block_stop", index: blockIndex };
        }

        yield {
          type: "finish",
          stopReason,
          usage: accumulatedUsage,
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
          partialUsage: accumulatedUsage,
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
    const contentBlocks: ContentBlock[] = [];
    let usage: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let stopReason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" = "end_turn";

    for await (const event of this.chatStream(target, req, opts)) {
      if (event.type === "content_block_start") {
        contentBlocks.push(event.block);
      } else if (event.type === "content_block_delta") {
        const block = contentBlocks[event.index];
        if (block && block.type === "text" && event.delta.type === "text_delta") {
          block.text += event.delta.text;
        } else if (block && block.type === "reasoning" && event.delta.type === "reasoning_delta") {
          block.text += event.delta.text;
        }
      } else if (event.type === "finish") {
        stopReason = event.stopReason;
        if (event.usage) usage = event.usage;
      } else if (event.type === "error") {
        throw new InferenceError({
          code: event.error.code as any,
          message: event.error.message,
          providerAccount: target.providerAccount,
          model: target.model,
          retryable: event.error.retryable,
        });
      }
    }

    const assistantMessage: any = {
      role: "assistant",
      content: contentBlocks.length > 0 ? contentBlocks : [{ type: "text", text: "" }],
    };

    return {
      message: assistantMessage,
      stopReason,
      usage,
    };
  }
}
