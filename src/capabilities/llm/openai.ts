import { OpenAI } from '../../vendors/openai.js';
import { ProviderMessage, ProviderResponse, ProviderToolCall, LLMProvider, ChatOptions, StreamDelta } from '../../foundations/contracts/llm.js';
import type { ToolDefinition } from '../../foundations/contracts/tool.js';

export class OpenAIProvider implements LLMProvider {
  private client: OpenAI;
  private model: string;

  constructor(apiKey: string, model: string, baseURL?: string) {
    this.client = new OpenAI({ apiKey, baseURL });
    this.model = model;
  }

  async chat(messages: ProviderMessage[], tools: ToolDefinition[], options?: ChatOptions): Promise<ProviderResponse> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: messages as OpenAI.ChatCompletionMessageParam[],
      tools: tools as OpenAI.ChatCompletionTool[],
    }, { signal: options?.signal });

    const message = response.choices[0]?.message;
    if (!message) return {};

    const usage = response.usage ? {
      promptTokens: response.usage.prompt_tokens,
      completionTokens: response.usage.completion_tokens,
      totalTokens: response.usage.total_tokens,
      cost: 0,
    } : undefined;

    return {
      content: message.content ?? undefined,
      tool_calls: message.tool_calls
        ?.filter((tc): tc is OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall => tc.type === 'function')
        .map((tc): ProviderToolCall => ({
          id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments,
        })),
      usage,
    };
  }

  /**
   * Stream the response using the OpenAI SDK's native streaming. Maps chunks to
   * `StreamDelta`s: text deltas, tool-call begin (id+name on the first chunk)
   * and argument fragments (subsequent chunks, keyed by `index`), and a final
   * `finish` with usage (when `stream_options.include_usage` is set).
   */
  async *chatStream(messages: ProviderMessage[], tools: ToolDefinition[], options?: ChatOptions): AsyncIterable<StreamDelta> {
    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages: messages as OpenAI.ChatCompletionMessageParam[],
      tools: tools as OpenAI.ChatCompletionTool[],
      stream: true,
      stream_options: { include_usage: true },
    }, { signal: options?.signal });

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (delta?.content) {
        yield { type: 'text_delta', content: delta.content };
      }
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          if (tc.function?.name) {
            yield { type: 'tool_call_begin', index: tc.index, id: tc.id ?? '', name: tc.function.name };
          }
          if (tc.function?.arguments) {
            yield { type: 'tool_call_delta', index: tc.index, argumentsDelta: tc.function.arguments };
          }
        }
      }
      if (chunk.usage) {
        yield {
          type: 'finish',
          usage: {
            promptTokens: chunk.usage.prompt_tokens,
            completionTokens: chunk.usage.completion_tokens,
            totalTokens: chunk.usage.total_tokens,
            cost: 0,
          },
        };
      }
    }
  }
}
