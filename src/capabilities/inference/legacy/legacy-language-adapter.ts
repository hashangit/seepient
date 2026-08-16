import type {
  LanguageBackend,
  InferenceTarget,
  LanguageRequest,
  InferenceOptions,
} from "../../../foundations/contracts/backend-ports.js";
import type {
  StreamEvent,
  InferenceResponse,
  CanonicalMessage,
  ContentBlock,
  Usage,
} from "../../../foundations/schemas/inference.js";
import { OpenAIProvider } from "../../llm/openai.js";
import { AnthropicProvider } from "../../llm/anthropic.js";
import { InferenceError } from "../../../foundations/errors.js";
import type { ProviderMessage, ProviderToolCall } from "../../../foundations/contracts/llm.js";

/** Convert CanonicalMessage[] to ProviderMessage[] for legacy providers */
export function canonicalToProviderMessages(messages: CanonicalMessage[]): ProviderMessage[] {
  const result: ProviderMessage[] = [];

  for (const m of messages) {
    if (m.role === "system") {
      const text = m.content.map((b) => b.text).join("\n");
      result.push({ role: "system", content: text });
    } else if (m.role === "user") {
      const parts: string[] = [];
      for (const block of m.content) {
        if (block.type === "text") {
          parts.push(block.text);
        } else if (block.type === "tool_result") {
          const resText = block.content
            .filter((c): c is { type: "text"; text: string } => c.type === "text")
            .map((c) => c.text)
            .join("\n");
          parts.push(`[Tool Result for ${block.toolUseId}]: ${resText}`);
        }
      }
      result.push({ role: "user", content: parts.join("\n") });
    } else if (m.role === "assistant") {
      const textParts: string[] = [];
      const toolCalls: ProviderToolCall[] = [];

      for (const block of m.content) {
        if (block.type === "text") {
          textParts.push(block.text);
        } else if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id,
            name: block.name,
            arguments: JSON.stringify(block.input),
          });
        }
      }

      result.push({
        role: "assistant",
        content: textParts.length > 0 ? textParts.join("\n") : undefined,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      });
    } else if (m.role === "tool") {
      for (const block of m.content) {
        const text = block.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text)
          .join("\n");
        result.push({
          role: "tool",
          tool_call_id: block.toolUseId,
          content: text,
        });
      }
    }
  }

  return result;
}

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
 * Legacy language adapter implementing LanguageBackend via direct OpenAI / Anthropic SDK wrappers.
 */
export class LegacyLanguageAdapter implements LanguageBackend {
  private createProvider(target: InferenceTarget, apiKey: string) {
    if (target.upstreamProvider === "openai" || target.upstreamProvider === "openai-compatible") {
      return new OpenAIProvider(apiKey, target.model, target.baseUrl);
    }
    if (target.upstreamProvider === "anthropic" || target.upstreamProvider === "glm") {
      return new AnthropicProvider(apiKey, target.model, target.baseUrl ? { baseURL: target.baseUrl } : undefined);
    }
    throw new InferenceError({
      code: "unsupported_capability",
      message: `Legacy provider does not support upstream provider "${target.upstreamProvider}"`,
      providerAccount: target.providerAccount,
      model: target.model,
      retryable: false,
    });
  }

  async *chatStream(
    target: InferenceTarget,
    req: LanguageRequest,
    opts?: InferenceOptions,
  ): AsyncIterable<StreamEvent> {
    const lease = target.credential.acquireLease();
    const { signal, cleanup } = resolveSignal(opts);

    try {
      const secret = await lease.secret();
      if (secret.kind !== "api_key") {
        throw new InferenceError({
          code: "auth",
          message: `Legacy language adapter requires an api_key credential, received kind "${secret.kind}"`,
          providerAccount: target.providerAccount,
          model: target.model,
          retryable: false,
        });
      }

      const provider = this.createProvider(target, secret.value);
      const providerMessages = canonicalToProviderMessages(req.messages);

      yield {
        type: "start",
        resolvedModel: {
          modelId: target.model,
          providerAccount: target.providerAccount,
        },
      };

      let textBlockStarted = false;
      let hasToolCalls = false;
      const openToolIndices = new Set<number>();
      let accumulatedUsage: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

      try {
        if (typeof provider.chatStream === "function") {
          for await (const delta of provider.chatStream(providerMessages, req.tools ?? [], { signal })) {
            if (delta.type === "text_delta" && delta.content) {
              if (!textBlockStarted) {
                textBlockStarted = true;
                yield {
                  type: "content_block_start",
                  index: 0,
                  block: { type: "text", text: "" },
                };
              }
              yield {
                type: "content_block_delta",
                index: 0,
                delta: {
                  type: "text_delta",
                  text: delta.content,
                },
              };
            } else if (delta.type === "tool_call_begin") {
              hasToolCalls = true;
              if (textBlockStarted) {
                yield { type: "content_block_stop", index: 0 };
                textBlockStarted = false;
              }
              const toolBlockIndex = 1 + delta.index;
              openToolIndices.add(toolBlockIndex);
              yield {
                type: "content_block_start",
                index: toolBlockIndex,
                block: {
                  type: "tool_use",
                  id: delta.id,
                  name: delta.name,
                  input: {},
                },
              };
            } else if (delta.type === "tool_call_delta") {
              const toolBlockIndex = 1 + delta.index;
              yield {
                type: "content_block_delta",
                index: toolBlockIndex,
                delta: {
                  type: "tool_input_delta",
                  partialJson: delta.argumentsDelta,
                },
              };
            } else if (delta.type === "finish") {
              if (delta.usage) {
                accumulatedUsage = {
                  promptTokens: delta.usage.promptTokens ?? 0,
                  completionTokens: delta.usage.completionTokens ?? 0,
                  totalTokens: delta.usage.totalTokens ?? 0,
                };
              }
              if (textBlockStarted) {
                yield { type: "content_block_stop", index: 0 };
                textBlockStarted = false;
              }
              for (const idx of openToolIndices) {
                yield { type: "content_block_stop", index: idx };
              }
              openToolIndices.clear();

              yield {
                type: "finish",
                stopReason: hasToolCalls ? "tool_use" : "end_turn",
                usage: accumulatedUsage,
              };
              return;
            }
          }
        }

        if (textBlockStarted) {
          yield { type: "content_block_stop", index: 0 };
        }
        for (const idx of openToolIndices) {
          yield { type: "content_block_stop", index: idx };
        }

        yield {
          type: "finish",
          stopReason: hasToolCalls ? "tool_use" : "end_turn",
          usage: accumulatedUsage,
        };
      } catch (streamErr: any) {
        const isAbort = signal?.aborted;
        if (isAbort) {
          yield {
            type: "abort",
            reason: signal?.reason?.message || "Stream aborted",
            partialUsage: accumulatedUsage,
          };
        } else {
          yield {
            type: "error",
            error: {
              code: "network",
              message: streamErr?.message || "Streaming error occurred",
              retryable: true,
            },
            partialUsage: accumulatedUsage,
          };
        }
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
      const secret = await lease.secret();
      if (secret.kind !== "api_key") {
        throw new InferenceError({
          code: "auth",
          message: `Legacy language adapter requires an api_key credential, received kind "${secret.kind}"`,
          providerAccount: target.providerAccount,
          model: target.model,
          retryable: false,
        });
      }

      const provider = this.createProvider(target, secret.value);
      const providerMessages = canonicalToProviderMessages(req.messages);

      let resp;
      try {
        resp = await provider.chat(providerMessages, req.tools ?? [], { signal });
      } catch (err: any) {
        const isTimeout = signal?.aborted && opts?.timeoutMs;
        throw new InferenceError({
          code: isTimeout ? "timeout" : "network",
          message: err?.message || "Chat request failed",
          providerAccount: target.providerAccount,
          model: target.model,
          retryable: true,
          cause: err,
        });
      }

      const contentBlocks: (ContentBlock & { type: "text" | "tool_use" })[] = [];
      if (resp.content) {
        contentBlocks.push({
          type: "text",
          text: resp.content,
        });
      }
      if (resp.tool_calls && resp.tool_calls.length > 0) {
        for (const tc of resp.tool_calls) {
          let input: Record<string, unknown> = {};
          try {
            input = JSON.parse(tc.arguments);
          } catch {
            input = { raw: tc.arguments };
          }
          contentBlocks.push({
            type: "tool_use",
            id: tc.id,
            name: tc.name,
            input,
          });
        }
      }

      // If neither text nor tool calls exist, ensure at least one text block
      if (contentBlocks.length === 0) {
        contentBlocks.push({ type: "text", text: "" });
      }

      const stopReason = resp.tool_calls && resp.tool_calls.length > 0 ? "tool_use" : "end_turn";

      return {
        message: {
          role: "assistant",
          content: contentBlocks,
        },
        stopReason,
        usage: {
          promptTokens: resp.usage?.promptTokens ?? 0,
          completionTokens: resp.usage?.completionTokens ?? 0,
          totalTokens: resp.usage?.totalTokens ?? 0,
        },
      };
    } finally {
      cleanup();
      await lease.release();
    }
  }
}
