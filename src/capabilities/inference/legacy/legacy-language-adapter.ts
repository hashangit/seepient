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
  ToolUseBlock,
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

/**
 * Legacy language adapter implementing LanguageBackend via direct OpenAI / Anthropic SDK wrappers.
 */
export class LegacyLanguageAdapter implements LanguageBackend {
  private createProvider(target: InferenceTarget, secret: string) {
    if (target.upstreamProvider === "openai" || target.upstreamProvider === "openai-compatible") {
      return new OpenAIProvider(secret, target.model, target.baseUrl);
    }
    if (target.upstreamProvider === "anthropic" || target.upstreamProvider === "glm") {
      return new AnthropicProvider(secret, target.model, target.baseUrl ? { baseURL: target.baseUrl } : undefined);
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
    try {
      const secret = await lease.secret();
      const provider = this.createProvider(target, secret);
      const providerMessages = canonicalToProviderMessages(req.messages);

      yield {
        type: "start",
        resolvedModel: {
          modelId: target.model,
          providerAccount: target.providerAccount,
        },
      };

      let blockIndex = 0;
      if (typeof provider.chatStream === "function") {
        for await (const delta of provider.chatStream(providerMessages, req.tools ?? [], { signal: opts?.signal })) {
          if (delta.type === "text_delta" && delta.content) {
            yield {
              type: "content_block_delta",
              index: blockIndex,
              delta: {
                type: "text_delta",
                text: delta.content,
              },
            };
          } else if (delta.type === "tool_call_begin") {
            blockIndex = delta.index;
            yield {
              type: "content_block_start",
              index: blockIndex,
              block: {
                type: "tool_use",
                id: delta.id,
                name: delta.name,
                input: {},
              },
            };
          } else if (delta.type === "tool_call_delta") {
            yield {
              type: "content_block_delta",
              index: delta.index,
              delta: {
                type: "tool_input_delta",
                partialJson: delta.argumentsDelta,
              },
            };
          } else if (delta.type === "finish") {
            yield {
              type: "finish",
              stopReason: "end_turn",
              usage: {
                promptTokens: delta.usage?.promptTokens ?? 0,
                completionTokens: delta.usage?.completionTokens ?? 0,
                totalTokens: delta.usage?.totalTokens ?? 0,
              },
            };
            return;
          }
        }
      }

      yield {
        type: "finish",
        stopReason: "end_turn",
        usage: {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
        },
      };
    } finally {
      await lease.release();
    }
  }

  async chat(
    target: InferenceTarget,
    req: LanguageRequest,
    opts?: InferenceOptions,
  ): Promise<InferenceResponse> {
    const lease = target.credential.acquireLease();
    try {
      const secret = await lease.secret();
      const provider = this.createProvider(target, secret);
      const providerMessages = canonicalToProviderMessages(req.messages);
      const resp = await provider.chat(providerMessages, req.tools ?? [], { signal: opts?.signal });

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
      await lease.release();
    }
  }
}
